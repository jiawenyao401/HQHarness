"""Desktop entry for the pinned xasp CLI and SDK."""

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import re
import secrets
import stat
import sys
import threading
import unicodedata
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
XASP = ROOT / "xasp"
sys.path[:0] = [
    str(XASP / "apps/cli/src"),
    str(XASP / "packages/sdk/src"),
    str(ROOT / "site-packages"),
]

WORKFLOWS = {
    "oa-travel-expense": "travel_expense",
    "oa-home-travel-expense": "home_travel",
    "oa-business-travel-application": "travel_application_flow",
    "oa-reception-expense": "reception_expense",
}
BUSINESS_FIELDS = {
    "travel_expense": {
        "applicationDate", "reason", "destination", "travelerName", "dateStart",
        "dateEnd", "days", "payment", "subsidy", "title",
    },
    "home_travel": {"applicationDate", "reason", "travelerName", "trips", "payment", "title"},
    "travel_application_flow": {
        "apply_date", "reason", "entries", "trip_days", "itinerary", "request_name",
        "security_level", "companions",
    },
    "reception_expense": {"applicationDate", "reason", "travelerName", "lines", "payment", "title"},
}
EXECUTION_KEYS = {
    "path", "file", "filepath", "files", "attachment", "attachments", "attachmentids",
    "fileid", "filetype", "infoid", "ocrmap", "invoiceflag", "userid", "operatorid",
    "requestid", "creationpending", "savepending", "submitted", "submissionpending",
    "workflowid", "workflowcontext", "formid", "draft", "draftevidence", "nativedraft",
    "testsimulation", "terminalfailure", "applicantcontext", "traveleroption",
    "baseurl", "tenantkey", "corpid", "appkey", "appsecret", "environment", "account",
}
MAX_INPUT = 256 * 1024
MAX_MATERIAL_BYTES = 12 * 1024 * 1024
MAX_MATERIAL_TOTAL = 20 * 1024 * 1024
STATUS_LABELS = {"草稿", "待提交", "draft", "pending", "pending submission"}
SAFE_TOKEN = re.compile(r"[A-Za-z0-9_.\[\]-]{1,96}\Z")
ID = re.compile(r"[1-9][0-9]{0,39}\Z")
HOME_MINUTE = re.compile(r"(?:上午|下午|晚上|中午)?\d{1,2}[:点时](\d{1,2})分?\Z")
HOME_NOTE_LIMIT = 100
HOME_LEGACY_TIME_EXPLANATION = "（OA仅支持小时，按所在小时展示）"
CREATION_REFERENCE = re.compile(r"[0-9a-f]{32}\Z")
CREATION_TITLE_LIMIT = 1000
CREATION_TITLE_SUFFIX = " [HQ-{}]"
DEFAULT_DRAFT_TITLES = {
    "travel_expense": "差旅报销",
    "home_travel": "往返居住地报销",
    "travel_application_flow": "出差申请",
    "reception_expense": "业务接待报销",
}


class WorkerFailure(Exception):
    def __init__(self, code):
        self.code = code


def fail(code):
    raise WorkerFailure(code)


def require_object(value):
    if not isinstance(value, dict):
        fail("INVALID_INPUT")
    return value


def identifier(value):
    if isinstance(value, (int, str)) and not isinstance(value, bool) and ID.fullmatch(str(value)):
        return str(value)
    return None


def hash_file(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def digest(value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(data.encode()).hexdigest()


def private_directory(value):
    if not isinstance(value, str):
        fail("INVALID_INPUT")
    path = Path(value)
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        fail("INVALID_JOB_DIRECTORY")
    return path.resolve(strict=True)


def material_sources(values, root):
    if not isinstance(values, list) or len(values) > 8:
        fail("MATERIAL_COUNT_LIMIT")
    sources = []
    seen_paths = set()
    total = 0
    for value in values:
        value = require_object(value)
        if set(value) != {"path", "kind"} or value["kind"] not in ("invoice", "attachment"):
            fail("MATERIAL_SOURCE_INVALID")
        if not isinstance(value["path"], str):
            fail("MATERIAL_SOURCE_INVALID")
        raw = Path(value["path"])
        if not raw.is_absolute() or raw.is_symlink():
            fail("MATERIAL_SOURCE_INVALID")
        path = raw.resolve(strict=True)
        if not path.is_relative_to(root) or path in seen_paths:
            fail("MATERIAL_SOURCE_INVALID")
        info = path.stat()
        total += info.st_size
        if (
            not stat.S_ISREG(info.st_mode)
            or not 0 < info.st_size <= MAX_MATERIAL_BYTES
            or total > MAX_MATERIAL_TOTAL
        ):
            fail("MATERIAL_SOURCE_INVALID")
        seen_paths.add(path)
        sources.append({"path": str(path), "kind": value["kind"], "sha256": hash_file(path)})
    return sources


def business_intake(value, workflow, operator_id, sources):
    value = require_object(value)
    if value.keys() - BUSINESS_FIELDS[workflow]:
        fail("INVALID_BUSINESS_FIELDS")

    def verify_fields(item, depth=0, parent=""):
        if depth > 12:
            fail("INVALID_BUSINESS_FIELDS")
        if isinstance(item, dict):
            for key, child in item.items():
                normalized = key.replace("_", "").lower()
                if key.startswith("_") or (normalized in EXECUTION_KEYS and not (
                    parent == "payment" and normalized == "account"
                )):
                    fail("INVALID_BUSINESS_FIELDS")
                verify_fields(child, depth + 1, key)
        elif isinstance(item, list):
            if len(item) > 120:
                fail("INVALID_BUSINESS_FIELDS")
            for child in item:
                verify_fields(child, depth + 1, parent)

    verify_fields(value)
    data = copy.deepcopy(value)
    data["userid"] = operator_id or ""
    if isinstance(data.get("payment"), dict):
        data["payment"] = {**data["payment"], "doNotRemember": True}
    if workflow == "travel_application_flow":
        data["attachments"] = [{"path": row["path"]} for row in sources]
    else:
        data["files"] = [{"path": row["path"], "kind": row["kind"]} for row in sources]
    return data


def normalize_name(value):
    return " ".join(unicodedata.normalize("NFC", value).split()) if isinstance(value, str) else ""


def payment_gap(workflow, intake):
    if workflow == "travel_application_flow":
        return None
    payment = intake.get("payment")
    traveler = normalize_name(intake.get("travelerName"))
    if (
        not isinstance(payment, dict) or not traveler
        or not all(isinstance(payment.get(key), str) and payment[key].strip() for key in ("payee", "bank", "account"))
        or normalize_name(payment["payee"]) != traveler
    ):
        return {"field": "payment"}
    return None


def home_note_length(note):
    return len(note.encode("utf-16-le", errors="surrogatepass")) // 2


def prepare_home_times(intake):
    """Validate source precision before projecting to the OA hour controls."""
    from oa_cli.intake_normalize import _coerce_date, _coerce_hour

    gaps = []
    trips = intake.get("trips")
    if not isinstance(trips, list):
        return gaps
    for index, trip in enumerate(trips):
        if not isinstance(trip, dict):
            continue
        times = {}
        source_times = {}
        for field in ("departure", "arrival"):
            value = trip.get(field)
            if value in (None, ""):
                continue
            parts = value.strip().replace("T", " ", 1).split(maxsplit=2) if isinstance(value, str) else []
            if len(parts) < 2:
                gaps.append({"field": f"trips[{index}].{field}"})
                continue
            day = _coerce_date(parts[0])
            hour, _ = _coerce_hour(parts[1])
            matched = HOME_MINUTE.fullmatch(parts[1])
            minute = int(matched[1]) if matched else None
            if not day or not hour or (":" in parts[1] and not matched) or (minute is not None and minute > 59):
                gaps.append({"field": f"trips[{index}].{field}"})
                continue
            times[field] = (f"{day} {hour}", minute)
            if minute is not None:
                source_times[field] = " ".join(parts[:2])
        if "departure" in times and "arrival" in times:
            depart_hour, depart_minute = times["departure"]
            arrive_hour, arrive_minute = times["arrival"]
            if depart_hour > arrive_hour or (
                depart_hour == arrive_hour and depart_minute is not None
                and arrive_minute is not None and depart_minute > arrive_minute
            ):
                gaps.append({"field": f"trips[{index}].arrival"})
        for field, (hour, _) in times.items():
            trip[field] = hour
        if source_times:
            trip["ticketTimes"] = source_times
            notes = [str(trip.get("tssm") or "")]
            for field, label in (("departure", "出发"), ("arrival", "到达")):
                if field in source_times:
                    notes.append(f"原票{label}={source_times[field]}")
            trip["tssm"] = "；".join(note for note in notes if note)
        if home_note_length(str(trip.get("tssm") or "")) > HOME_NOTE_LIMIT:
            gaps.append({
                "field": f"trips[{index}].tssm", "code": "HOME_NOTE_TOO_LONG",
                "maxLength": HOME_NOTE_LIMIT,
            })
    return gaps


def pending_home_arrivals(intake):
    trips = intake.get("trips")
    if not isinstance(trips, list):
        return []
    return [
        {"field": f"trips[{index}].arrival"} for index, trip in enumerate(trips)
        if isinstance(trip, dict) and trip.get("arrival") in (None, "")
    ]


def configure(value, root):
    value = require_object(value)
    if value.get("environment") != "test" or value.get("account") not in ("lgw", "wwb"):
        fail("OA_TEST_CONFIGURATION_REQUIRED")
    for key, maximum in {
        "corpid": 512, "appKey": 512, "appSecret": 4096, "tenantKey": 512, "operatorName": 160,
    }.items():
        item = value.get(key)
        if not isinstance(item, str) or not 0 < len(item.strip()) <= maximum or "\x00" in item:
            fail("OA_TEST_CONFIGURATION_REQUIRED")
    if value.get("operatorId") is not None and not identifier(value["operatorId"]):
        fail("OPERATOR_BINDING_INVALID")

    for key in tuple(os.environ):
        if key.upper().startswith("OA_") or key.upper() in {
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
        }:
            del os.environ[key]
    os.environ.update(OA_ENV="test", OA_ACCOUNT=value["account"])
    from oa_cli import person
    from oa_sdk import OaClient, OaConfig
    from oa_sdk import _client as sdk_client

    config = OaConfig.from_env(
        corpid=value["corpid"], app_key=value["appKey"], app_secret=value["appSecret"],
        tenant_key=value["tenantKey"], token_cache_dir=root / "cache", timeout=20,
    )
    class ProcessTokenStore(sdk_client.TokenStore):
        """Retain upstream token lifecycle without persisting bearer credentials."""

        def _load_from_disk(self):
            return None

        def _save_to_disk(self, data):
            pass

        def _invalidate_disk(self):
            pass

    original_token_store = sdk_client.TokenStore
    try:
        sdk_client.TokenStore = ProcessTokenStore
        client = OaClient(config=config)
    finally:
        sdk_client.TokenStore = original_token_store
    # The packaged applicant helper performs a second organization lookup.
    # Bind it to this same TEST client so it cannot load a separate dotenv.
    person.get_client = lambda: client
    return client


def travel_binding(client, value):
    from oa_cli.travel_expense import FORM_ID, _schema_path

    binding = value.get("travelWorkflowBinding")
    if not isinstance(binding, dict):
        fail("ENVIRONMENT_SCHEMA_UNVERIFIED")
    schema = hash_file(_schema_path())
    source_flag = binding.get("invoiceSourceFlag")
    if (
        not identifier(binding.get("workflowId"))
        or binding.get("formId") != FORM_ID
        or binding.get("schemaSha256") != schema
        or (source_flag is not None and (type(source_flag) is not int or source_flag < 0))
    ):
        fail("ENVIRONMENT_SCHEMA_UNVERIFIED")
    fixed = {
        "base_url": client.config.base_url,
        "tenant_key": client.config.tenant_key,
        "workflow_id": str(binding["workflowId"]),
        "form_id": FORM_ID,
        "schema_sha256": schema,
    }
    if source_flag is not None:
        fixed["invoice_source_flag"] = source_flag
    os.environ["OA_TRAVEL_WORKFLOW_BINDING"] = json.dumps(fixed)
    return fixed


def find_operator(client, name, expected=None):
    from oa_cli.draft_status import ensure_auth

    ensure_auth(client)
    wanted = normalize_name(name)
    if not wanted:
        fail("OPERATOR_BINDING_INVALID")
    found = []
    seen = set()
    total = None
    for page in range(1, 21):
        response = client.person.query_employee(
            name_like_list=[name.strip()], current=page, page_size=1000,
            return_field_list=["id", "username"],
        ).data
        if response is None or response.current != page or not isinstance(response.data, list):
            fail("OPERATOR_DIRECTORY_INCOMPLETE")
        if total is None:
            total = response.total
        if not isinstance(total, int) or total < 0 or response.total != total:
            fail("OPERATOR_DIRECTORY_INCOMPLETE")
        for row in response.data:
            row_id = identifier(row.id)
            if not row_id or row_id in seen or not normalize_name(row.name):
                fail("OPERATOR_DIRECTORY_INCOMPLETE")
            seen.add(row_id)
            if normalize_name(row.name) == wanted:
                found.append((row_id, row.name))
        if len(seen) == total:
            break
        if len(seen) > total or not response.data:
            fail("OPERATOR_DIRECTORY_INCOMPLETE")
    else:
        fail("OPERATOR_DIRECTORY_INCOMPLETE")
    if len(found) != 1 or (expected is not None and found[0][0] != str(expected)):
        fail("OPERATOR_BINDING_INVALID")
    return found[0]


def material_facts(sources, root):
    if not sources:
        return []
    helper = XASP / "skill/common/oa-script-runtime/scripts/intake_materials.py"
    spec = importlib.util.spec_from_file_location("xasp_desktop_intake_materials", helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    packet = module.read_packet([row["path"] for row in sources], cache_dir=root / "materials-cache")
    by_path = {row.get("path"): row for row in packet.get("materials", [])}
    remaining = 16_384
    result = []
    for source in packet.get("inputSources", []):
        row = by_path.get(source.get("canonicalPath"), {})
        content = row.get("text")
        text = content[:min(4096, remaining)] if isinstance(content, str) else ""
        for material in sources:
            text = text.replace(material["path"], "[材料]")
        remaining -= len(text)
        facts = {
            "index": source["index"], "materialIndex": source["index"] + 1,
            "untrustedMaterial": True, "text": text,
        }
        for key in ("status", "classificationCandidate"):
            value = row.get(key)
            if isinstance(value, str) and SAFE_TOKEN.fullmatch(value):
                facts[key] = value
        result.append(facts)
    return result


def reception_line_indexes(intake):
    """Require every multi-invoice line to name exactly one staged invoice."""
    expected = {
        index for index, source in enumerate(intake["files"], start=1)
        if source["kind"] == "invoice"
    }
    if len(expected) < 2:
        return []
    lines = intake.get("lines")
    if not isinstance(lines, list) or len(lines) != len(expected):
        fail("INVOICE_LINE_BINDING_REQUIRED")
    indexes = [line.get("materialIndex") if isinstance(line, dict) else None for line in lines]
    if any(type(index) is not int for index in indexes) or set(indexes) != expected:
        fail("INVOICE_LINE_BINDING_REQUIRED")
    return indexes


def bind_reception_invoice_facts(intake, indexes):
    """Populate each line only with facts from its selected, uploaded original."""
    from oa_cli.travel_expense import _invoice_ready

    seen = set()
    for line, index in zip(intake["lines"], indexes, strict=True):
        source = intake["files"][index - 1]
        info_id = identifier(source.get("infoId"))
        if not info_id or not _invoice_ready(source):
            fail("MATERIAL_PROCESSING_FAILED")
        if info_id in seen:
            fail("INVOICE_SOURCE_CONFLICT")
        seen.add(info_id)
        for field in ("buyer", "date"):
            supplied = line.get(field)
            if supplied not in (None, "") and normalize_name(supplied) != normalize_name(source[field]):
                fail("INVOICE_SOURCE_CONFLICT")
            line[field] = source[field]
        try:
            invoice_total = Decimal(str(source["amount"]))
            amount = line.get("amount")
            reported = invoice_total if amount in (None, "") else Decimal(str(amount))
        except (InvalidOperation, TypeError, ValueError):
            fail("INVOICE_AMOUNT_INVALID")
        if not invoice_total.is_finite() or not reported.is_finite() or not 0 < reported <= invoice_total:
            fail("INVOICE_AMOUNT_INVALID")
        line["amount"] = str(reported)
        line["infoId"] = info_id
        description = line.get("description") or intake.get("reason")
        if isinstance(description, str) and description.strip():
            line["description"] = description
            source["description"] = description


def defer_reception_ocr_gaps(result, intake, indexes):
    """Offline checks cannot resolve trusted invoice identifiers or OCR facts."""
    if result.get("code") != "GAPS" or not isinstance(result.get("gaps"), list):
        return result
    deferred = {f"files[{index - 1}]" for index in indexes}
    for offset, line in enumerate(intake["lines"]):
        deferred.update(
            f"lines[{offset}].{field}" for field in ("buyer", "date", "amount", "infoId")
            if line.get(field) in (None, "")
        )
        if not line.get("description") and isinstance(intake.get("reason"), str) and intake["reason"].strip():
            deferred.add(f"lines[{offset}].description")
    missing = [gap for gap in result["gaps"] if gap.get("field") not in deferred]
    if missing:
        return {**result, "gaps": missing}
    return {
        "ok": True, "action": "check",
        "deferred": [gap["field"] for gap in result["gaps"]],
    }


def safe_result(result, operation):
    public = {"ok": result.get("ok") is True, "action": operation}
    for key in ("code", "status", "nextAction", "upstreamCode", "stage"):
        value = result.get(key)
        if isinstance(value, str) and SAFE_TOKEN.fullmatch(value):
            public[key] = value
    if "requestId" in result and identifier(result["requestId"]):
        public["requestId"] = str(result["requestId"])
    for key in ("verified", "oaSaved", "businessComplete", "fieldsReady"):
        if isinstance(result.get(key), bool):
            public[key] = result[key]
    for key in ("gaps", "pendingItems"):
        items = result.get(key)
        if isinstance(items, list):
            public[key] = []
            for item in items[:50]:
                if not isinstance(item, dict):
                    continue
                field = item.get("field")
                if isinstance(field, str) and SAFE_TOKEN.fullmatch(field):
                    public[key].append({"field": field})
    deferred = result.get("deferred")
    if isinstance(deferred, list):
        public["deferred"] = [
            field for field in deferred[:50] if isinstance(field, str) and SAFE_TOKEN.fullmatch(field)
        ]
    return public


def execute(workflow, intake, client=None, job=None):
    module = __import__("oa_cli." + workflow, fromlist=["execute"])
    if workflow == "travel_application_flow":
        return module.execute(intake, client=client, job_path=job, submit=False)
    output = io.StringIO()
    kwargs = {"client": client, "job_path": job}
    if workflow == "travel_expense":
        kwargs["write"] = client is not None
    indexes = reception_line_indexes(intake) if workflow == "reception_expense" else []
    with contextlib.redirect_stdout(output):
        if indexes and client is not None:
            # The pinned CLI only links a single invoice automatically. Adapt its
            # form-builder input after its upload and OCR stages have completed.
            build_form_data = module.build_form_data

            def build_with_bound_invoices(data):
                bind_reception_invoice_facts(data, indexes)
                return build_form_data(data)

            module.build_form_data = build_with_bound_invoices
            try:
                module.execute(intake, **kwargs)
            finally:
                module.build_form_data = build_form_data
        else:
            module.execute(intake, **kwargs)
    result = require_object(json.loads(output.getvalue()))
    if indexes and client is None:
        return defer_reception_ocr_gaps(result, intake, indexes)
    return result


class DraftService:
    """Allow only xasp's draft methods and journal their side effects."""

    def __init__(self, service, before_write, reads, writes, snapshots=None, after_create=None):
        self.service = service
        self.before_write = before_write
        self.reads = reads
        self.writes = writes
        self.snapshots = snapshots
        self.after_create = after_create

    def __getattr__(self, name):
        if name == "get_workflow_request" and self.snapshots is not None:
            def read_snapshot(*args, **kwargs):
                response = self.service.get_workflow_request(*args, **kwargs)
                key = (identifier(kwargs.get("userid")), identifier(kwargs.get("request_id")))
                self.snapshots[key] = response
                return response

            return read_snapshot
        if name == "_request" and name in self.reads:
            def read(method, path, **kwargs):
                if method != "GET" or path != "/workflow/v2/getFieldById":
                    fail("DRAFT_OPERATION_DENIED")
                return self.service._request(method, path, **kwargs)

            return read
        if name in self.reads:
            return getattr(self.service, name)
        if name not in self.writes:
            fail("DRAFT_OPERATION_DENIED")

        def write(*args, **kwargs):
            if name == "create_request" and kwargs.get("isnextflow") != 0:
                fail("DRAFT_OPERATION_DENIED")
            self.before_write(name, kwargs)
            response = getattr(self.service, name)(*args, **kwargs)
            if name == "create_request" and self.after_create is not None:
                self.after_create(response)
            return response

        return write


class DraftClient:
    def __init__(self, client, before_write, after_create=None):
        self.client = client
        self.snapshots = {}
        self.workflow = DraftService(
            client.workflow, before_write,
            {"get_workflow_request", "my_list", "_request"}, {"create_request"},
            self.snapshots, after_create,
        )
        self.invoice = DraftService(
            client.invoice, before_write, {"valid_invoice"}, {"upload_file", "ocr_recognize"},
        )

    def __getattr__(self, name):
        return getattr(self.client, name)


def read_state(path):
    if path.is_symlink():
        fail("INVALID_JOB_STATE")
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as stream:
        return require_object(json.load(stream))


def request_id(state):
    return identifier(state.get("requestId")) or identifier(state.get("request_id"))


def create_response_id(response):
    # The pinned application and expense runners use the same response keys.
    from oa_cli.travel_apply import _extract_request_id, _model_dump

    data = _model_dump(response)
    message = data.get("message")
    if message is None:
        message = {}
    if not isinstance(message, dict):
        fail("CREATION_UNCERTAIN")
    draft_id = identifier(_extract_request_id(data))
    if not draft_id or any(
        str(part.get("errcode", "0")) != "0"
        or ("requestId" in part and identifier(part["requestId"]) != draft_id)
        for part in (message, data)
    ):
        fail("CREATION_UNCERTAIN")
    return draft_id


def returned_request_id(state, saved):
    if "returnedRequestId" not in state:
        return None
    draft_id = identifier(state["returnedRequestId"])
    if not draft_id or state.get("write") != "create_request" or any(
        key in saved and identifier(saved[key]) != draft_id for key in ("requestId", "request_id")
    ):
        fail("INVALID_JOB_STATE")
    return draft_id


def verify_draft_identity(snapshot, workflow_id, form_id, operator_id, draft_id):
    from oa_cli._workflow_snapshot import response_dict

    if snapshot is None:
        return False
    data = response_dict(snapshot).get("data") or {}
    base = data.get("workflowBaseInfo") or {}
    status = base.get("flowStatus")
    form = data.get("formData") or {}
    form_identity = (form.get("form") or {}).get("id")
    form_ids = [str(value) for value in (form.get("formId"), form_identity) if value is not None]
    code = status.get("code") if isinstance(status, dict) else None
    description = status.get("desc") if isinstance(status, dict) else status
    return (
        str(base.get("requestId")) == draft_id
        and str(base.get("workflowId")) == workflow_id
        and str(base.get("userId")) == operator_id
        and form_ids and all(value == form_id for value in form_ids)
        and str(description).strip().lower() in STATUS_LABELS
        and (code is None or str(code) in ("0", "6"))
        and not any(
            str(row.get("logType", "")).upper() == "SUBMIT"
            for row in data.get("workflowRequestLogs", []) if isinstance(row, dict)
        )
    )


def matches_legacy_home_note(mismatch, intake):
    trips = intake.get("trips")
    index = mismatch.get("dataIndex")
    if not isinstance(trips, list) or type(index) is not int or not 1 <= index <= len(trips):
        return False
    trip = trips[index - 1]
    times = trip.get("ticketTimes") if isinstance(trip, dict) else None
    expected, actual = mismatch.get("expectedContent"), mismatch.get("actualContent")
    if (
        not isinstance(times, dict) or not isinstance(expected, str) or not isinstance(actual, str)
        or expected != trip.get("tssm")
        or home_note_length(actual) != HOME_NOTE_LIMIT or not expected.startswith(actual)
    ):
        return False
    fields = ("departure", "arrival")
    if not all(isinstance(times.get(field), str) and times[field] for field in fields):
        return False
    legacy_pair = "；".join(f"原票{field}={times[field]}{HOME_LEGACY_TIME_EXPLANATION}" for field in fields)
    # OA clipped old notes at its field limit. Only the trailing explanation may be missing.
    return (
        (expected == legacy_pair or expected.endswith("；" + legacy_pair))
        and 0 < len(expected) - len(actual) <= len(HOME_LEGACY_TIME_EXPLANATION)
    )


def verify_desktop_form(form, snapshot, home_intake=None):
    from oa_cli import home_travel
    from oa_cli._workflow_snapshot import _options, verify_form_data

    if form.get("formId") != home_travel.FORM_ID:
        return verify_form_data(form, snapshot)["ok"]
    details = []
    for row in form["dataDetails"]:
        if isinstance(row, dict) and row.get("fieldId") == home_travel.FIELDS["sqbm"] and row.get("dataIndex") is None:
            options = _options(row)
            if options and all(option.get("optionId") for option in options):
                # OA resolves Department labels. The option ID is the persisted identity.
                row = {**row, "dataOptions": [{"optionId": option["optionId"]} for option in options]}
        details.append(row)
    result = verify_form_data({**form, "dataDetails": details}, snapshot)
    if result["ok"]:
        return True
    return (
        home_intake is not None and bool(result["mismatches"])
        and not any(result[key] for key in ("missing", "ambiguous", "optionResolutionErrors", "unexpected", "anomalies"))
        and all(
            item["fieldId"] == home_travel.FIELDS["tssm"] and matches_legacy_home_note(item, home_intake)
            for item in result["mismatches"]
        )
    )


def verify_created_form(state, snapshot, form_id, home_intake=None):
    creation = state.get("creation")
    form = creation.get("form") if isinstance(creation, dict) else None
    return (
        isinstance(form, dict) and form.get("formId") == form_id
        and isinstance(form.get("dataDetails"), list) and bool(form["dataDetails"])
        and verify_desktop_form(form, snapshot, home_intake)
    )


def with_pending_arrivals(result, pending):
    if pending and all(result.get(key) is True for key in ("ok", "oaSaved", "verified")):
        result.pop("gaps", None)
        result.update(
            status="draft_saved_incomplete", businessComplete=False, fieldsReady=False,
            pendingItems=pending,
        )
    return result


def draft_title(workflow, raw):
    field = "request_name" if workflow == "travel_application_flow" else "title"
    title = raw.get(field)
    if title is None:
        return DEFAULT_DRAFT_TITLES[workflow]
    suffix_length = len(CREATION_TITLE_SUFFIX.format("0" * 32))
    if not isinstance(title, str) or not title.strip() or not title.isprintable():
        fail("INVALID_DRAFT_TITLE")
    if len(title) + suffix_length > CREATION_TITLE_LIMIT:
        fail("DRAFT_TITLE_TOO_LONG")
    return title


def find_creation_candidate(client, operator_id, workflow_id, reference, title):
    from oa_cli._summarize.workflow_list import summarize_list_mine
    from oa_cli._workflow_snapshot import response_dict

    candidates = set()
    seen = set()
    page_size = 20
    for page in range(1, 6):
        response = client.workflow.my_list(
            userid=int(operator_id), page_no=page, page_size=page_size,
            keyword=reference, workflow_ids=[workflow_id],
        )
        raw = response_dict(response)
        data = raw.get("data")
        if not isinstance(data, list) or len(data) > page_size:
            return None
        items = []
        for row in data:
            if not isinstance(row, dict):
                return None
            base = row.get("workflowBaseInfo")
            items.append({**base, **row} if isinstance(base, dict) else row)
        rows = summarize_list_mine({**raw, "data": items}, page=page, page_size=page_size)["items"]
        if not rows:
            return next(iter(candidates)) if len(candidates) == 1 else None
        for row in rows:
            found = identifier(row["requestId"])
            if not found or found in seen:
                return None
            seen.add(found)
            if row["requestName"] == title and row["workflowId"] == workflow_id:
                candidates.add(found)
        if len(candidates) > 1:
            return None
    return None


def creation_intent(state, form_id):
    creation = state.get("creation")
    if not isinstance(creation, dict):
        fail("INVALID_JOB_STATE")
    reference, title, form = (creation.get(key) for key in ("reference", "title", "form"))
    if (
        not isinstance(reference, str) or not CREATION_REFERENCE.fullmatch(reference)
        or not isinstance(title, str) or not title.endswith(CREATION_TITLE_SUFFIX.format(reference))
        or not isinstance(form, dict) or form.get("formId") != form_id
        or not isinstance(form.get("dataDetails"), list) or not form["dataDetails"]
    ):
        fail("INVALID_JOB_STATE")
    return reference, title, form


def recover_creation(client, state, saved, job, workflow, workflow_id, form_id, operator_id):
    from oa_cli._workflow_snapshot import response_dict
    from oa_cli.draft_status import ensure_auth
    from oa_cli.draft_verification import write_job

    if state.get("write") != "create_request" or not isinstance(state.get("creation"), dict):
        fail("CREATION_UNCERTAIN")
    reference, title, form = creation_intent(state, form_id)
    try:
        ensure_auth(client)
        candidate = find_creation_candidate(client, operator_id, workflow_id, reference, title)
        if candidate:
            snapshot = client.workflow.get_workflow_request(userid=int(operator_id), request_id=int(candidate))
            base = (response_dict(snapshot).get("data") or {}).get("workflowBaseInfo") or {}
            if (
                not verify_draft_identity(snapshot, workflow_id, form_id, operator_id, candidate)
                or base.get("requestName") != title
                or not verify_desktop_form(form, snapshot, saved if workflow == "home_travel" else None)
            ):
                candidate = None
    except Exception:
        # Query failures and incomplete evidence leave the original create intent intact.
        fail("CREATION_UNCERTAIN")
    if not candidate:
        fail("CREATION_UNCERTAIN")
    saved["request_id" if workflow == "travel_application_flow" else "requestId"] = candidate
    saved.pop("creation_pending", None)
    write_job(job, saved)
    return candidate


def active_schema_fields(client, form_id, operator_id):
    response = client.workflow._request(
        "GET", "/workflow/v2/getFieldById",
        params={"userid": operator_id, "id": form_id},
    )
    rows = response.get("formFields") if isinstance(response, dict) else None
    if not isinstance(rows, list) or not rows or any(not isinstance(row, dict) for row in rows):
        fail("ENVIRONMENT_SCHEMA_UNVERIFIED")
    by_id = {str(row.get("id")): row for row in rows}
    if len(by_id) != len(rows):
        fail("ENVIRONMENT_SCHEMA_UNVERIFIED")
    return {field_id: row for field_id, row in by_id.items() if row.get("delete") is False}


def verify_home_schema(client, module, operator_id):
    from oa_cli.home_native_draft import _INVOICE, _MAIN, _PAYMENT, _TYPES

    by_id = active_schema_fields(client, module.FORM_ID, operator_id)
    subforms = {
        **dict.fromkeys(_MAIN, "-1"),
        **dict.fromkeys(_INVOICE, "1261538251147984898"),
        **dict.fromkeys(_PAYMENT, "1266387299376275465"),
    }
    for key, field_id in module.FIELDS.items():
        row = by_id.get(field_id, {})
        if (
            row.get("dataKey") != key
            or row.get("componentKey") != _TYPES.get(key, "Text")
            or str(row.get("subFormId")) != subforms.get(key, "1253331513746121563")
        ):
            fail("ENVIRONMENT_SCHEMA_UNVERIFIED")
    return by_id


def verify_expense_schema(workflow, client, module, operator_id):
    if workflow == "home_travel":
        return verify_home_schema(client, module, operator_id)
    by_id = active_schema_fields(client, module.FORM_ID, operator_id)
    if workflow == "travel_expense":
        if not set(module._field_ids().values()).issubset(by_id):
            fail("ENVIRONMENT_SCHEMA_UNVERIFIED")
    elif any(by_id.get(field_id, {}).get("dataKey") != key for key, field_id in module.FIELDS.items()):
        fail("ENVIRONMENT_SCHEMA_UNVERIFIED")


def revision_input(workflow, raw):
    """Accept sourced business corrections only. Identifiers come from the saved job."""
    allowed = {
        "travel_expense": {"payment"}, "home_travel": {"payment", "home"},
        "travel_application_flow": {"city"}, "reception_expense": {"payment"},
    }[workflow]

    def valid_text(value):
        return isinstance(value, str) and 0 < len(value) <= 256 and value.strip() == value and value.isprintable()

    if not isinstance(raw, dict) or not raw or raw.keys() - allowed:
        fail("INVALID_REVISION_FIELDS")
    if "payment" in raw:
        payment = raw["payment"]
        if (
            not isinstance(payment, dict) or set(payment) != {"payee", "bank", "account"}
            or not all(valid_text(value) for value in payment.values())
        ):
            fail("INVALID_REVISION_FIELDS")
    if "home" in raw and not valid_text(raw["home"]):
        fail("INVALID_REVISION_FIELDS")
    if "city" in raw:
        city = raw["city"]
        if (
            not isinstance(city, dict) or set(city) != {"index", "name"}
            or type(city["index"]) is not int or not 1 <= city["index"] <= 120
            or not valid_text(city["name"])
        ):
            fail("INVALID_REVISION_FIELDS")


def revision_form(snapshot, form_id):
    """Keep all non-empty logical fields and the CLI's structural validation."""
    from oa_cli._workflow_snapshot import _field_id, _has_value, _options, _subform_id, build_summary, response_dict

    diagnostics = build_summary(snapshot).get("diagnostics", {})
    if any(value for key, value in diagnostics.items() if key != "placeholderOnlyRows"):
        fail("REVISION_DRAFT_STRUCTURE")
    original = response_dict(snapshot)["data"]["formData"]
    rows = {}
    for row in original["dataDetails"]:
        if not _has_value(row):
            continue
        field, index = _field_id(row), row.get("dataIndex")
        if (field, index) in rows:
            fail("REVISION_DRAFT_STRUCTURE")
        detail = {"fieldId": field}
        if index is not None:
            detail["dataIndex"] = index
        subform = _subform_id(row)
        if subform:
            detail["subFormId"] = subform
        options = _options(row)
        if options:
            if any(not item.get("optionId") for item in options):
                fail("REVISION_DRAFT_STRUCTURE")
            detail["dataOptions"] = options
        else:
            detail["content"] = row["content"]
        rows[field, index] = detail
    if not rows:
        fail("REVISION_DRAFT_STRUCTURE")
    return {"formId": form_id, "module": "workflow"}, rows


def revision_changes(workflow, module, raw, saved, rows):
    from oa_cli.cities import load_rows, match_city

    def resolve_city(name):
        option, error = match_city(name, load_rows())
        if error or not option:
            fail("REVISION_CITY_UNRESOLVED")
        return [{"optionId": option["optionId"], "content": option["content"]}]

    changes = []
    if "payment" in raw:
        payment = raw["payment"]
        if normalize_name(payment["payee"]) != normalize_name(saved.get("travelerName")):
            fail("REVISION_PAYEE_MISMATCH")
        if workflow == "travel_expense":
            ids = module._field_ids()
            fields = [ids[key] for key in ("收款人", "开户银行", "银行账号", "付款金额")]
        else:
            fields = [module.FIELDS[key] for key in ("skr", "khyx", "yxzh", "fkje")]
        if {index for field, index in rows if field in fields} != {1}:
            fail("REVISION_PAYMENT_ROW_REQUIRED")
        anchor = rows.get((fields[3], 1), {})
        if not anchor.get("subFormId"):
            fail("REVISION_PAYMENT_ROW_REQUIRED")
        for field, key in zip(fields[:3], ("payee", "bank", "account"), strict=True):
            changes.append((field, 1, anchor["subFormId"], {"content": payment[key]}))
    if "home" in raw:
        options = resolve_city(raw["home"])
        trips = saved.get("trips")
        anchors = {index: row for (field, index), row in rows.items() if field == module.FIELDS["jtgj"]}
        if not isinstance(trips, list) or not trips or set(anchors) != set(range(1, len(trips) + 1)):
            fail("REVISION_ITINERARY_ROW_REQUIRED")
        for index, row in anchors.items():
            changes.append((module.FIELDS["jzd"], index, row.get("subFormId"), {"dataOptions": options}))
    if "city" in raw:
        index = raw["city"]["index"]
        entries = saved.get("entries")
        details = {field["dataKey"]: field["fieldId"] for field in module.SCHEMA["detailTable"]["fields"]}
        anchor = rows.get((details["qzsj"], index), {})
        if not isinstance(entries, list) or index > len(entries) or not anchor.get("subFormId"):
            fail("REVISION_ITINERARY_ROW_REQUIRED")
        changes.append((details["ccdd"], index, anchor["subFormId"], {"dataOptions": resolve_city(raw["city"]["name"])}))
    return changes


def revision_result(operation, client, state, state_path, workflow_id, form_id, operator_id, draft_id):
    """Read only. Reconcile a durable pending patch if the entire target is confirmed."""
    from oa_cli.draft_verification import write_job

    revision = state["revision"]
    if (
        not isinstance(revision, dict) or revision.get("requestId") != draft_id
        or type(revision.get("pending")) is not bool or not isinstance(revision.get("expected"), dict)
        or type(revision.get("patchedFields")) is not int
    ):
        fail("INVALID_JOB_STATE")
    snapshot = None
    try:
        observed = client.workflow.get_workflow_request(userid=int(operator_id), request_id=int(draft_id))
        if (
            verify_draft_identity(observed, workflow_id, form_id, operator_id, draft_id)
            and verify_desktop_form(revision["expected"], observed)
        ):
            snapshot = observed
    except Exception:
        # A failed readback does not authorize another mutation.
        pass
    if snapshot is None:
        return {
            "ok": False, "action": operation, "requestId": draft_id,
            "code": "SAVE_UNCERTAIN" if revision["pending"] else "VERIFY_FAILED",
            **({"status": "unknown"} if revision["pending"] else {}),
        }, None
    if revision["pending"]:
        revision["pending"] = False
        write_job(state_path, state)
    return {
        "ok": True, "action": operation, "requestId": draft_id, "workflowId": workflow_id,
        "formId": form_id, "oaSaved": True, "verified": True, "businessComplete": False,
        "patchedFields": revision["patchedFields"],
    }, snapshot


def with_draft_link(result, config):
    request_id = identifier(result.get("requestId"))
    if (
        not request_id or config.environment != "test" or result.get("ok") is not True
        or result.get("verified") is not True or result.get("oaSaved") is not True
    ):
        return result
    origin = urlsplit(getattr(config, "web_url", ""))
    if (
        origin.scheme not in {"http", "https"} or not origin.hostname
        or origin.username or origin.password or origin.query or origin.fragment or origin.path not in {"", "/"}
    ):
        return result
    return {**result, "draftUrl": origin.geturl().rstrip("/") + "/sp/workflow/flowpage/view/" + request_id}


def revise_draft(workflow, module, raw, saved, snapshot, client, state, state_path, workflow_id, operator_id, draft_id):
    from oa_cli._workflow_snapshot import verify_form_data
    from oa_cli.draft_verification import write_job

    form, rows = revision_form(snapshot, module.FORM_ID)
    changes = revision_changes(workflow, module, raw, saved, rows)
    patch = []
    for field, index, subform, value in changes:
        if not subform:
            fail("REVISION_DRAFT_STRUCTURE")
        detail = {"fieldId": field, "dataIndex": index, **value}
        expected = {**detail, "subFormId": subform}
        if verify_form_data({"dataDetails": [expected]}, snapshot, allow_unexpected=True)["ok"]:
            continue
        if (field, index) in rows and rows[field, index].get("subFormId") != subform:
            fail("REVISION_DRAFT_STRUCTURE")
        rows[field, index] = expected
        patch.append(detail)
    if not patch:
        return {"ok": False, "action": "revise", "code": "REVISION_NO_CHANGE", "requestId": draft_id}
    if workflow == "travel_application_flow":
        if module.write_schema_gap(client, saved):
            fail("ENVIRONMENT_SCHEMA_UNVERIFIED")
    else:
        verify_expense_schema(workflow, client, module, operator_id)
    state["revision"] = {
        "requestId": draft_id, "pending": True, "patchedFields": len(patch),
        "expected": {**form, "dataDetails": list(rows.values())},
    }
    write_job(state_path, state)
    try:
        client.workflow.save_form_data(
            userid=int(operator_id), request_id=int(draft_id), form_data=form, data_details=patch,
        )
    except Exception:
        # The SDK may have sent the mutation. Reconcile with a single readback.
        pass
    return revision_result(
        "revise", client, state, state_path, workflow_id, module.FORM_ID, operator_id, draft_id,
    )[0]


def run_draft(operation, workflow, raw, client, configuration, root, sources, operator_id):
    from oa_cli.draft_status import ensure_auth
    from oa_cli.draft_verification import write_job
    from oa_cli.travel_complete import invoice_context, locked_job, uploaded_material_gaps

    module = __import__("oa_cli." + workflow, fromlist=["FORM_ID", "WORKFLOW_ID"])
    binding = travel_binding(client, configuration) if workflow == "travel_expense" else {}
    if workflow == "home_travel" and "homeInvoiceSourceFlag" in configuration:
        source_flag = configuration["homeInvoiceSourceFlag"]
        if type(source_flag) is not int or source_flag <= 0:
            fail("INVOICE_SOURCE_CONFIG_REQUIRED")
        binding["invoice_source_flag"] = source_flag
    workflow_id = binding.get("workflow_id", module.WORKFLOW_ID)
    job = root / "intake.json"
    state_path = root / "desktop-job.json"
    scope = digest([
        workflow, workflow_id, client.config.base_url, configuration["account"],
        configuration["corpid"], configuration["appKey"], configuration["tenantKey"], operator_id,
        binding.get("schema_sha256"), binding.get("invoice_source_flag"),
    ])

    # The desktop lock protects even the xasp workflows without their own intake lock.
    with locked_job(state_path):
        state = read_state(state_path)
        saved = read_state(job)
        existing = request_id(saved)
        pending_arrivals = pending_home_arrivals(saved) if workflow == "home_travel" else []
        incoming = digest([raw, [(row["sha256"], row["kind"]) for row in sources]]) if operation == "draft" else None
        if state and (state.get("scope") != scope or (
            incoming and state.get("input") != incoming
        )):
            fail("STATE_CONFLICT")
        if not state and (existing or saved.get("creation_pending")):
            fail("INVALID_JOB_STATE")
        returned = returned_request_id(state, saved)
        if not existing and (saved.get("creation_pending") or state.get("write") == "create_request"):
            if operation != "readback":
                if returned:
                    return {"ok": False, "code": "READBACK_UNCERTAIN", "requestId": returned}
                fail("CREATION_UNCERTAIN")
            if not returned:
                existing = recover_creation(client, state, saved, job, workflow, workflow_id, module.FORM_ID, operator_id)
            else:
                creation_intent(state, module.FORM_ID)
        if not (existing or returned) and state.get("write"):
            fail("MATERIAL_WRITE_UNCERTAIN")
        if operation in {"readback", "revise"} and not (existing or returned):
            fail("DRAFT_NOT_FOUND")
        if operation == "revise":
            if any(saved.get(key) for key in ("terminalFailure", "creation_pending", "save_pending", "submission_pending", "submitted")):
                fail("STATE_CONFLICT")
            find_operator(client, configuration["operatorName"], operator_id)
        if existing and "revision" in state:
            if operation == "revise" and isinstance(state["revision"], dict) and state["revision"].get("pending") is True:
                return {
                    "ok": False, "action": operation, "code": "SAVE_UNCERTAIN",
                    "status": "unknown", "requestId": existing,
                }
            ensure_auth(client)
            public, snapshot = revision_result(
                operation, client, state, state_path, workflow_id, module.FORM_ID, operator_id, existing,
            )
            if operation == "revise" and snapshot is not None:
                public = revise_draft(workflow, module, raw, saved, snapshot, client, state, state_path, workflow_id, operator_id, existing)
            return with_pending_arrivals(public, pending_arrivals)
        if returned or (existing and workflow == "home_travel"):
            # The create response identifies the draft even if OA rewrites the title.
            # Home travel also needs the exact form that was sent, including optional fields.
            draft_id = returned or existing
            try:
                ensure_auth(client)
                snapshot = client.workflow.get_workflow_request(userid=int(operator_id), request_id=int(draft_id))
            except Exception:
                return {"ok": False, "code": "READBACK_UNCERTAIN", "requestId": draft_id}
            if (
                not verify_draft_identity(snapshot, workflow_id, module.FORM_ID, operator_id, draft_id)
                or not verify_created_form(state, snapshot, module.FORM_ID, saved if workflow == "home_travel" else None)
            ):
                return {"ok": False, "action": operation, "code": "VERIFY_FAILED", "requestId": draft_id,
                        "verified": False, "oaSaved": False}
            if not existing:
                saved["request_id" if workflow == "travel_application_flow" else "requestId"] = draft_id
                saved.pop("creation_pending", None)
                write_job(job, saved)
            if operation == "revise":
                public = revise_draft(workflow, module, raw, saved, snapshot, client, state, state_path, workflow_id, operator_id, draft_id)
            else:
                public = {"ok": True, "action": operation, "requestId": draft_id, "verified": True,
                          "oaSaved": True, "workflowId": workflow_id, "formId": module.FORM_ID}
            return with_pending_arrivals(public, pending_arrivals)
        if existing:
            # Verify fields by reusing the exact runner, but deny uploads and all workflow writes.
            def deny_write(_name, _kwargs):
                fail("READBACK_WRITE_DENIED")

            ensure_auth(client)
            guarded = DraftClient(client, deny_write)
            result = execute(workflow, saved, guarded, job)
        else:
            intake = business_intake(raw, workflow, operator_id, sources)
            if workflow == "home_travel":
                if gaps := prepare_home_times(intake):
                    return {"ok": False, "action": operation, "code": "GAPS", "gaps": gaps}
                pending_arrivals = pending_home_arrivals(intake)
            # The pinned runner's fallback can recall an unverified payment row
            # by operator alone and may upload invoices before reporting a gap.
            if gap := payment_gap(workflow, intake):
                return {"ok": False, "action": operation, "code": "GAPS", "gaps": [gap]}
            reference = secrets.token_hex(16)
            title = draft_title(workflow, raw) + CREATION_TITLE_SUFFIX.format(reference)
            if workflow == "travel_application_flow":
                # The pinned runner also verifies this title on subsequent readback.
                intake["request_name"] = title
            if any(row["kind"] == "invoice" for row in sources):
                if workflow in {"home_travel", "travel_expense"}:
                    if binding.get("invoice_source_flag") is None:
                        fail("INVOICE_SOURCE_CONFIG_REQUIRED")
                    intake["invoiceFlag"] = binding["invoice_source_flag"]
            local = execute(workflow, copy.deepcopy(intake))
            if local.get("ok") is not True and (
                local.get("code") != "GAPS" or not local.get("gaps")
            ):
                return safe_result(local, operation)
            find_operator(client, configuration["operatorName"], operator_id)
            if workflow != "travel_application_flow":
                fields = verify_expense_schema(workflow, client, module, operator_id)
                if pending_arrivals and fields[module.FIELDS["ddsj"]].get("required") is not False:
                    return {"ok": False, "action": operation, "code": "GAPS", "gaps": pending_arrivals}
            # Readiness and all file paths stay scoped to the current job.
            write_lock = threading.Lock()

            def record_write(name, kwargs):
                with write_lock:
                    if state.get("write") == "create_request":
                        fail("DRAFT_OPERATION_DENIED")
                    if name == "upload_file":
                        source = next((row for row in sources if row["path"] == kwargs.get("file_path")), None)
                        if not source or hash_file(Path(source["path"])) != source["sha256"]:
                            fail("MATERIAL_SOURCE_CHANGED")
                    if name == "create_request":
                        form = kwargs.get("form_data")
                        if (
                            identifier(kwargs.get("userid")) != operator_id or kwargs.get("workflow_id") != workflow_id
                            or not isinstance(form, dict) or form.get("formId") != module.FORM_ID
                            or not isinstance(form.get("dataDetails"), list) or not form["dataDetails"]
                        ):
                            fail("DRAFT_OPERATION_DENIED")
                        if workflow in {"home_travel", "reception_expense"}:
                            files = read_state(job).get("files") or []
                            if len(files) != len(sources) or uploaded_material_gaps(files):
                                fail("MATERIAL_PROCESSING_FAILED")
                            try:
                                invoice_context(client, int(operator_id), files)
                            except Exception:
                                fail("INVOICE_VERIFICATION_FAILED")
                        kwargs["requestname"] = title
                        state["creation"] = {"reference": reference, "title": title, "form": form}
                    state.update(scope=scope, input=incoming, write=name)
                    write_job(state_path, state)

            def record_create_response(response):
                draft_id = create_response_id(response)
                with write_lock:
                    write_job(state_path, {**state, "returnedRequestId": draft_id})
                    state["returnedRequestId"] = draft_id

            guarded = DraftClient(client, record_write, record_create_response)
            try:
                result = execute(workflow, intake, guarded, job)
            except WorkerFailure:
                if state.get("write") != "create_request":
                    # xasp wrote its pending marker before invoking our guarded create.
                    # This worker still knows the request was never sent.
                    saved = read_state(job)
                    if saved.pop("creation_pending", None):
                        write_job(job, saved)
                raise
            except Exception:
                saved = read_state(job)
                existing = returned_request_id(state, saved) or request_id(saved)
                if existing:
                    return {"ok": False, "code": "READBACK_UNCERTAIN", "requestId": existing}
                if state.get("write") == "create_request":
                    fail("CREATION_UNCERTAIN")
                if state.get("write"):
                    fail("MATERIAL_WRITE_UNCERTAIN")
                raise
            if state.get("write") == "create_request":
                saved = read_state(job)
                returned = returned_request_id(state, saved)
                if not request_id(saved):
                    if returned:
                        return {"ok": False, "code": "READBACK_UNCERTAIN", "requestId": returned}
                    fail("CREATION_UNCERTAIN")
        public = safe_result(result, operation)
        draft_id = identifier(public.get("requestId"))
        if returned and draft_id and returned != draft_id:
            fail("INVALID_JOB_STATE")
        snapshot = guarded.snapshots.get((operator_id, draft_id))
        if public["ok"] and draft_id and verify_draft_identity(
            snapshot, workflow_id, module.FORM_ID, operator_id, draft_id,
        ) and (
            workflow != "home_travel" or verify_created_form(state, snapshot, module.FORM_ID)
        ) and (
            public.get("gaps") == pending_arrivals if pending_arrivals else public.get("verified") is True
        ):
            if operation == "revise":
                return revise_draft(workflow, module, raw, saved, snapshot, client, state, state_path, workflow_id, operator_id, draft_id)
            public.update(oaSaved=True, verified=True, workflowId=workflow_id, formId=module.FORM_ID)
        elif public["ok"]:
            public.update(ok=False, verified=False, oaSaved=False, code="VERIFY_FAILED")
        return with_pending_arrivals(public, pending_arrivals)


def main(payload):
    payload = require_object(payload)
    operation = payload.get("operation")
    if operation not in ("identity", "check", "draft", "readback", "revise"):
        fail("INVALID_OPERATION")
    root = private_directory(payload.get("jobDir"))
    config = payload.get("configuration")
    if operation == "identity":
        client = configure(config, root)
        operator_id, name = find_operator(client, config["operatorName"], config.get("operatorId"))
        return {"ok": True, "operatorId": operator_id, "operatorName": name}

    slug = payload.get("workflow")
    if not isinstance(slug, str) or slug not in WORKFLOWS:
        fail("INVALID_WORKFLOW")
    workflow = WORKFLOWS[slug]
    raw = payload.get("intake", {})
    sources = material_sources(payload.get("materials", []), root)
    if operation == "revise":
        if sources:
            fail("REVISION_MATERIALS_DENIED")
        revision_input(workflow, raw)
    if operation == "check":
        for key in tuple(os.environ):
            if key.upper().startswith("OA_"):
                del os.environ[key]
        os.environ["OA_ENV"] = "test"
        operator = identifier(config.get("operatorId")) if isinstance(config, dict) else None
        intake = business_intake(raw, workflow, operator, sources)
        draft_title(workflow, raw)
        time_gaps = prepare_home_times(intake) if workflow == "home_travel" else []
        try:
            result = {"ok": False, "action": operation, "code": "GAPS", "gaps": time_gaps} if time_gaps else safe_result(execute(workflow, intake), operation)
        except WorkerFailure as error:
            if error.code != "INVOICE_LINE_BINDING_REQUIRED":
                raise
            result = {"ok": False, "action": operation, "code": error.code}
        if (gap := payment_gap(workflow, intake)) and (result["ok"] or result.get("code") == "GAPS"):
            gaps = result.get("gaps", [])
            if gap not in gaps:
                gaps.append(gap)
            result.update(ok=False, code="GAPS", gaps=gaps)
        result["materials"] = material_facts(sources, root)
        return result
    client = configure(config, root)
    operator = identifier(config.get("operatorId"))
    if not operator:
        fail("OPERATOR_BINDING_INVALID")
    return with_draft_link(run_draft(operation, workflow, raw, client, config, root, sources, operator), client.config)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            fail("INPUT_TOO_LARGE")
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            result = main(json.loads(data))
    except WorkerFailure as error:
        result = {"ok": False, "code": error.code}
    except (json.JSONDecodeError, UnicodeError, RecursionError):
        result = {"ok": False, "code": "INVALID_INPUT"}
    except Exception as error:
        result = {"ok": False, "code": "OA_EXECUTION_FAILED"}
        if type(error).__name__ in {"ConnectTimeout", "ConnectError", "ReadTimeout", "ReadError"}:
            result["code"] = "OA_NETWORK_UNAVAILABLE"
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
