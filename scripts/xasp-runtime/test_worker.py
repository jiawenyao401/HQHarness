"""Offline acceptance against the prepared xasp runtime.

Run with its bundled Python: python -I -B scripts/xasp-runtime/test_worker.py [payload-directory]
"""

import copy
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(__file__).resolve()
RUNTIME = Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else SOURCE.parents[2] / ".build/xasp-runtime"
spec = importlib.util.spec_from_file_location("xasp_worker", RUNTIME / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

from oa_cli import home_native_draft, home_travel, reception_expense, travel_apply, travel_expense


PAYMENT = {"payee": "张三", "bank": "测试银行", "account": "00001234"}
DRAFT_ID = "9001"
CONFIG = {
    "environment": "test",
    "account": "lgw",
    "corpid": "fixture-corp",
    "appKey": "fixture-key",
    "appSecret": "fixture-secret",
    "tenantKey": "fixture-tenant",
    "operatorName": "张三",
    "operatorId": "100",
    "travelWorkflowBinding": {
        "workflowId": travel_expense.WORKFLOW_ID, "formId": travel_expense.FORM_ID,
        "schemaSha256": worker.hash_file(travel_expense._schema_path()),
    },
}
INTAKES = {
    "oa-business-travel-application": {
        "apply_date": "2026-10-19",
        "reason": "TEST 出差联调",
        "entries": [{"start_date": "2026-10-20", "end_date": "2026-10-20",
                     "headcount": 1, "city": "保定市"}],
    },
    "oa-home-travel-expense": {
        "travelerName": "张三",
        "payment": PAYMENT,
        "trips": [{"origin": "保定市", "home": "天津市", "transport": "高铁",
                   "departure": "2026-10-10 08", "arrival": "2026-10-10 11", "je": "320.00"}],
    },
    "oa-travel-expense": {
        "travelerName": "张三",
        "payment": PAYMENT,
        "reason": "TEST 差旅联调",
        "destination": "天津市",
        "dateStart": "2026-10-10",
        "dateEnd": "2026-10-10",
        "days": [{"date": "2026-10-10", "travel": True, "origin": "保定市",
                  "destination": "天津市", "transport": "高铁", "departureHour": "08",
                  "arrivalHour": "11", "je": "320.00"}],
    },
    "oa-reception-expense": {
        "travelerName": "张三", "reason": "TEST 接待联调", "payment": PAYMENT,
    },
}


class WorkflowFixture:
    def __init__(self):
        self.creates = 0
        self.reads = 0
        self.arguments = None
        self.timeout = False
        self.corrupt = False
        self.patches = []
        self.defer_patch = False
        self.pending_patch = None
        self.before_patch = lambda: None
        self.before_create = lambda: None
        self.recovery_pages = None
        self.recovery_queries = 0
        self.detail_operator = "100"
        self.detail_title = None
        self.submitted = False

    def _request(self, method, path, **kwargs):
        assert (method, path) == ("GET", "/workflow/v2/getFieldById")
        form_id = kwargs["params"]["id"]
        if form_id == travel_expense.FORM_ID:
            return {"formFields": [
                {"id": field_id, "delete": False} for field_id in travel_expense._field_ids().values()
            ]}
        if form_id == reception_expense.FORM_ID:
            return {"formFields": [
                {"id": field_id, "dataKey": key, "delete": False}
                for key, field_id in reception_expense.FIELDS.items()
            ]}
        if form_id == home_travel.FORM_ID:
            subforms = {
                **dict.fromkeys(home_native_draft._MAIN, -1),
                **dict.fromkeys(home_native_draft._INVOICE, 1261538251147984898),
                **dict.fromkeys(home_native_draft._PAYMENT, 1266387299376275465),
            }
            return {"formFields": [
                {"id": field_id, "dataKey": key, "required": False, "delete": False,
                 "componentKey": home_native_draft._TYPES.get(key, "Text"),
                 "subFormId": subforms.get(key, 1253331513746121563)}
                for key, field_id in home_travel.FIELDS.items()
            ]}
        assert form_id == travel_apply.FORM_ID
        schema = travel_apply.SCHEMA
        return {"formFields": [
            {"id": field["fieldId"], "dataKey": field["dataKey"], "required": False,
             "delete": False, "componentKey": field["component"],
             "subFormId": -1 if field in schema["mainFields"] else schema["detailTable"]["subFormId"]}
            for field in schema["mainFields"] + schema["detailTable"]["fields"]
        ]}

    def create_request(self, **kwargs):
        self.creates += 1
        self.arguments = copy.deepcopy(kwargs)
        assert kwargs["isnextflow"] == 0 and kwargs["userid"] == 100
        self.before_create()
        if self.timeout:
            raise TimeoutError("fixture unknown outcome")
        return {"message": {"requestId": DRAFT_ID}}

    def my_list(self, userid, page_no, page_size, **kwargs):
        assert userid == 100
        if not kwargs:
            return {"data": []}
        self.recovery_queries += 1
        assert page_size == 20
        assert kwargs["keyword"] in self.arguments["requestname"]
        assert kwargs["workflow_ids"] == [self.arguments["workflow_id"]]
        pages = self.recovery_pages
        if pages is None:
            pages = [[self.creation_list_row()]]
        return {"data": pages[page_no - 1] if page_no <= len(pages) else []}

    def creation_list_row(self):
        return {"requestid": DRAFT_ID, "requestname": self.arguments["requestname"],
                "workflowid": self.arguments["workflow_id"], "status": 6}

    def get_workflow_request(self, **kwargs):
        self.reads += 1
        assert kwargs == {"userid": 100, "request_id": int(DRAFT_ID)}
        form = copy.deepcopy(self.arguments["form_data"])
        if form["formId"] == travel_expense.FORM_ID:
            ids = travel_expense._field_ids()
            payments = {ids[key] for key in ("收款人", "开户银行", "银行账号", "付款金额")}
        elif form["formId"] in {home_travel.FORM_ID, reception_expense.FORM_ID}:
            module = home_travel if form["formId"] == home_travel.FORM_ID else reception_expense
            payments = {module.FIELDS[key] for key in ("skr", "khyx", "yxzh", "fkje")}
        else:
            payments = set()
        for row in form["dataDetails"]:
            if row.get("dataIndex"):
                subform = "701" if row["fieldId"] in payments else "702"
                row.update(subFormId=subform, rowId=f'{subform}-{row["dataIndex"]}')
        if self.corrupt:
            form["dataDetails"].pop()
        return {"data": {
            "formData": form,
            "workflowBaseInfo": {
                "requestId": DRAFT_ID, "workflowId": self.arguments["workflow_id"], "userId": self.detail_operator,
                "requestName": self.detail_title or self.arguments["requestname"],
                "flowStatus": {"desc": "流转中", "code": "1"} if self.submitted else {"desc": "待提交", "code": "6"},
            },
            "workflowRequestLogs": [],
        }}

    def apply_patch(self, details):
        rows = self.arguments["form_data"]["dataDetails"]
        for detail in details:
            rows[:] = [row for row in rows if (row["fieldId"], row.get("dataIndex")) != (
                detail["fieldId"], detail["dataIndex"],
            )]
            rows.append(copy.deepcopy(detail))

    def save_form_data(self, *, userid, request_id, form_data, data_details):
        assert userid == 100 and request_id == int(DRAFT_ID)
        assert form_data == {"formId": self.arguments["form_data"]["formId"], "module": "workflow"}
        self.before_patch()
        self.patches.append(copy.deepcopy(data_details))
        if self.defer_patch:
            self.pending_patch = data_details
            raise TimeoutError("save response lost")
        self.apply_patch(data_details)


def client_fixture(job):
    workflow = WorkflowFixture()
    configuration = SimpleNamespace(
        environment="test", account="lgw", base_url="http://test.invalid/api",
        web_url="http://test.invalid/",
        corpid="fixture-corp", app_key="fixture-key", tenant_key="fixture-tenant",
        token_cache_dir=job / "cache", workflows={
            name: {"form_id": module.FORM_ID, "workflow_id": module.WORKFLOW_ID,
                   "verified_for_write": True, "invoice_source_flag": "13"}
            for name, module in (("travel_application", travel_apply), ("reception_expense", reception_expense))
        },
    )

    def query_org(ids, **kwargs):
        row = SimpleNamespace(subcompanyid="300", name="测试单位")
        return SimpleNamespace(data=SimpleNamespace(data=[row]))

    def query_employee(**kwargs):
        return SimpleNamespace(data=SimpleNamespace(current=1, total=1, data=[
            SimpleNamespace(id="100", name="张三"),
        ]))

    invoice = SimpleNamespace(
        upload_file=lambda **kwargs: SimpleNamespace(
            data=SimpleNamespace(
                id="502" if kwargs["file_path"].endswith("second-invoice.txt") else "501",
                file_type="pdf", ocr_map="fixture",
            ),
        ),
        ocr_recognize=lambda **kwargs: {
            "data": {"infos": [{"info": {
                "id": "702" if kwargs["image_index"] == "502" else "701",
                "invoiceDate": "2026-10-11" if kwargs["image_index"] == "502" else "2026-10-10",
                "totalAmount": "100.00" if kwargs["image_index"] == "502" else "320.00",
                "type": "电子发票",
                "comm_info": {"buyer": {"company": "测试公司"}},
            }}]},
        },
        valid_invoice=lambda **kwargs: {"data": {"info": {"valid": True}}},
    )
    return SimpleNamespace(
        workflow=workflow, config=configuration, _config=configuration, invoice=invoice,
        _token_store=SimpleNamespace(get_valid_access_token=lambda: "fixture-token"),
        person=SimpleNamespace(
            query_org=query_org, query_employee=query_employee,
            get_user=lambda userid: {"user": {"id": userid, "username": "张三", "department": "200"}},
        ),
    )


class WorkerTests(unittest.TestCase):
    def test_configuration_uses_process_only_credentials(self):
        from oa_cli import person

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ), patch.object(
            person, "get_client", person.get_client,
        ):
            client = worker.configure(CONFIG, Path(directory))
            try:
                self.assertEqual(client.config.environment, "test")
                self.assertEqual(client.config.app_secret, CONFIG["appSecret"])
                self.assertIs(person.get_client(), client)
                self.assertNotIn("OA_TEST_APP_SECRET", os.environ)
                client.token_store.save("fixture-access", "fixture-refresh", 3600)
                self.assertEqual(client.token_store.get_valid_access_token(), "fixture-access")
                self.assertFalse(list(Path(directory).rglob("token_cache.json")))
            finally:
                client.close()

    def test_identity_requires_exhaustive_unique_pages(self):
        from oa_sdk.api.person.models import QueryEmployeeResponse

        def reply(page, total, *names):
            return QueryEmployeeResponse.model_validate({
                "data": {"current": page, "total": total, "data": [
                    {"id": identifier, "username": name} for identifier, name in names
                ]}
            })

        with tempfile.TemporaryDirectory() as directory:
            client = client_fixture(Path(directory))
            client.person.query_employee = lambda current, **kwargs: {
                1: reply(1, 2, ("100", "张三")),
                2: reply(2, 2, ("101", "张三丰")),
            }[current]
            self.assertEqual(worker.find_operator(client, "张三", "100"), ("100", "张三"))
            client.person.query_employee = lambda current, **kwargs: reply(
                current, 2, (str(99 + current), "张三"),
            )
            with self.assertRaisesRegex(worker.WorkerFailure, "OPERATOR_BINDING_INVALID"):
                worker.find_operator(client, "张三")
            client.person.query_employee = lambda current, **kwargs: reply(1, 2, ("100", "张三"))
            with self.assertRaisesRegex(worker.WorkerFailure, "OPERATOR_DIRECTORY_INCOMPLETE"):
                worker.find_operator(client, "张三")

    def run_fixture(self, workflow, job, *, corrupt=False, timeout=False):
        client = client_fixture(job)
        client.workflow.corrupt = corrupt
        client.workflow.timeout = timeout
        materials = []
        if workflow == "oa-reception-expense":
            invoice = job / "invoice.txt"
            invoice.write_text("测试公司 电子发票", encoding="utf-8")
            materials.append({"path": str(invoice), "kind": "invoice"})
        payload = {
            "operation": "draft", "workflow": workflow, "configuration": copy.deepcopy(CONFIG),
            "jobDir": str(job), "intake": copy.deepcopy(INTAKES[workflow]), "materials": materials,
        }
        return client, payload

    def test_reception_payment_gap_precedes_upload_and_can_be_corrected(self):
        from oa_cli import person

        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            client, payload = self.run_fixture("oa-reception-expense", job)
            upload = client.invoice.upload_file
            attempts = []

            def record_upload(**kwargs):
                attempts.append(kwargs["file_path"])
                return upload(**kwargs)

            client.invoice.upload_file = record_upload
            with patch.object(worker, "configure", return_value=client), patch.object(person, "get_client", return_value=client):
                for payment in (None, {**PAYMENT, "payee": "另一个人"}):
                    payload["intake"]["payment"] = payment
                    result = worker.main(payload)
                    self.assertEqual(result["code"], "GAPS")
                    self.assertIn({"field": "payment"}, result["gaps"])
                    self.assertFalse(attempts)
                    self.assertFalse((job / "desktop-job.json").exists())
                payload["intake"]["payment"] = PAYMENT
                self.assertTrue(worker.main(payload)["oaSaved"])
                self.assertEqual(len(attempts), 1)

    def test_home_source_minutes_are_validated_and_preserved_in_the_form(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            client, payload = self.run_fixture("oa-home-travel-expense", job)
            attachment = job / "receipt.txt"
            attachment.write_text("测试车票", encoding="utf-8")
            payload["materials"] = [{"path": str(attachment), "kind": "attachment"}]
            trip = payload["intake"]["trips"][0]
            with patch.object(worker, "configure", return_value=client), patch(
                "oa_cli.person.get_client", return_value=client,
            ), patch.dict(os.environ), patch.object(client.invoice, "upload_file", wraps=client.invoice.upload_file) as upload:
                for departure, arrival, field in (
                    ("2026-10-10 08:59", "2026-10-10 08:05", "arrival"),
                    ("2026/10/10 08:72", "2026-10-10 11:03", "departure"),
                    ("2026-10-10 08:", "2026-10-10 11:03", "departure"),
                ):
                    trip.update(departure=departure, arrival=arrival)
                    for operation in ("check", "draft"):
                        result = worker.main({**payload, "operation": operation})
                        self.assertEqual(result["code"], "GAPS")
                        self.assertEqual(result["gaps"], [{"field": f"trips[0].{field}"}])
                    upload.assert_not_called()
                    self.assertEqual(client.workflow.creates, 0)
                    self.assertFalse((job / "desktop-job.json").exists())

                trip.update(departure="2026-10-10 08", arrival="2026-10-10 11", tssm="说明" * 50 + "字")
                for operation in ("check", "draft"):
                    result = worker.main({**payload, "operation": operation})
                    self.assertEqual(result["code"], "GAPS")
                    self.assertEqual(result["gaps"], [{
                        "field": "trips[0].tssm", "code": "HOME_NOTE_TOO_LONG", "maxLength": 100,
                    }])

                trip.update(departure="2026-10-10 08:30", arrival="2026-10-10 08:59", tssm="保留原备注")
                evidence = "；原票出发=2026-10-10 08:30；原票到达=2026-10-10 08:59"
                supplied_note = "保留原备注" + "说" * (100 - len("保留原备注" + evidence))
                trip["tssm"] = supplied_note[:-1] + "🚆"
                for operation in ("check", "draft"):
                    result = worker.main({**payload, "operation": operation})
                    self.assertEqual(result["code"], "GAPS")
                    self.assertEqual(result["gaps"][0]["code"], "HOME_NOTE_TOO_LONG")
                upload.assert_not_called()
                self.assertEqual(client.workflow.creates, 0)
                self.assertFalse((job / "desktop-job.json").exists())

                trip["tssm"] = supplied_note
                self.assertTrue(worker.main(payload)["verified"])
                upload.assert_called_once()
                fields = {row["fieldId"]: row.get("content") for row in client.workflow.arguments["form_data"]["dataDetails"]}
                self.assertEqual(fields[home_travel.FIELDS["cfsj"]], "2026-10-10 08")
                self.assertEqual(fields[home_travel.FIELDS["ddsj"]], "2026-10-10 08")
                note = fields[home_travel.FIELDS["tssm"]]
                self.assertEqual(note, supplied_note + evidence)
                self.assertEqual(len(note), 100)
                stored = worker.read_state(job / "intake.json")
                self.assertEqual(stored["trips"][0]["ticketTimes"], {
                    "departure": "2026-10-10 08:30", "arrival": "2026-10-10 08:59",
                })

    def test_home_legacy_readback_only_accepts_truncated_boilerplate_and_resolved_department(self):
        from oa_cli.draft_verification import write_job

        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            client, payload = self.run_fixture("oa-home-travel-expense", job, timeout=True)
            trip = payload["intake"]["trips"][0]
            times = {"departure": "2026-10-10 08:30", "arrival": "2026-10-10 11:45"}
            trip.update(times)
            readback = {**payload, "operation": "readback", "intake": {}, "materials": []}
            with patch.object(worker, "configure", return_value=client), patch(
                "oa_cli.person.get_client", return_value=client,
            ), patch.dict(os.environ):
                with self.assertRaisesRegex(worker.WorkerFailure, "CREATION_UNCERTAIN"):
                    worker.main(payload)

                intake_path = job / "intake.json"
                state_path = job / "desktop-job.json"
                saved = worker.read_state(intake_path)
                state = worker.read_state(state_path)
                observed = {row["fieldId"]: row for row in client.workflow.arguments["form_data"]["dataDetails"]}
                expected = {row["fieldId"]: row for row in state["creation"]["form"]["dataDetails"]}
                note_id = home_travel.FIELDS["tssm"]
                legacy_evidence = "；".join(
                    f"原票{field}={value}（OA仅支持小时，按所在小时展示）" for field, value in times.items()
                )
                legacy_note = "测" * (112 - len(legacy_evidence)) + "；" + legacy_evidence
                saved["trips"][0]["tssm"] = expected[note_id]["content"] = legacy_note
                write_job(intake_path, saved)
                write_job(state_path, state)
                observed[note_id]["content"] = legacy_note[:100]
                department = observed[home_travel.FIELDS["sqbm"]]["dataOptions"][0]
                department["content"] = "OA 解析后的部门显示名称"

                client.workflow.detail_title = "旧草稿标题不匹配"
                with self.assertRaisesRegex(worker.WorkerFailure, "CREATION_UNCERTAIN"):
                    worker.main(readback)
                client.workflow.detail_title = None
                self.assertEqual(worker.main(readback)["requestId"], DRAFT_ID)
                self.assertTrue(worker.main(readback)["verified"])
                saved = worker.read_state(intake_path)

                home = observed[home_travel.FIELDS["jzd"]]["dataOptions"][0]
                for target, field, changed in (
                    (department, "optionId", "999"),
                    (home, "optionId", "999"),
                    (home, "content", "其他城市"),
                    (observed[note_id], "content", legacy_note[:99]),
                    (observed[note_id], "content", "异" + legacy_note[1:100]),
                    (observed[note_id], "content", legacy_note[:100].replace("11:45", "11:46")),
                ):
                    with self.subTest(field=field, changed=changed):
                        original = target[field]
                        target[field] = changed
                        self.assertEqual(worker.main(readback)["code"], "VERIFY_FAILED")
                        target[field] = original
                lost_source_note = "测" * 24 + legacy_note
                saved["trips"][0]["tssm"] = expected[note_id]["content"] = lost_source_note
                write_job(intake_path, saved)
                write_job(state_path, state)
                observed[note_id]["content"] = lost_source_note[:100]
                self.assertEqual(worker.main(readback)["code"], "VERIFY_FAILED")
                saved["trips"][0]["tssm"] = expected[note_id]["content"] = legacy_note
                write_job(intake_path, saved)
                write_job(state_path, state)
                observed[note_id]["content"] = legacy_note[:100]

                correction = {**PAYMENT, "bank": "另一个测试银行", "account": "00004567"}
                revision = worker.main({**readback, "operation": "revise", "intake": {"payment": correction}})
                self.assertEqual(revision["requestId"], DRAFT_ID)
                self.assertTrue(revision["verified"])
                self.assertEqual({row["fieldId"] for row in client.workflow.patches[0]},
                                 {home_travel.FIELDS["khyx"], home_travel.FIELDS["yxzh"]})
                self.assertEqual(worker.main(readback)["requestId"], DRAFT_ID)
                self.assertEqual(client.workflow.creates, 1)
                self.assertEqual(len(client.workflow.patches), 1)

    def test_home_missing_arrival_requires_optional_schema_and_exact_readback(self):
        from oa_cli.draft_verification import write_job

        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            client, payload = self.run_fixture("oa-home-travel-expense", job)
            attachment = job / "receipt.txt"
            attachment.write_text("测试机票", encoding="utf-8")
            payload["materials"] = [{"path": str(attachment), "kind": "attachment"}]
            payload["intake"]["trips"][0].pop("arrival")
            readback = {**payload, "operation": "readback", "intake": {}, "materials": []}
            params = {"id": home_travel.FORM_ID}
            rows = client.workflow._request("GET", "/workflow/v2/getFieldById", params=params)["formFields"]
            pending = [{"field": "trips[0].arrival"}]
            state_path = job / "desktop-job.json"
            with patch.object(worker, "configure", return_value=client), patch(
                "oa_cli.person.get_client", return_value=client,
            ), patch.dict(os.environ), patch.object(client.invoice, "upload_file", wraps=client.invoice.upload_file) as upload:
                for required in (True, None):
                    blocked = [{**row, "required": required} if row["id"] == home_travel.FIELDS["ddsj"] else row for row in rows]
                    with patch.object(client.workflow, "_request", return_value={"formFields": blocked}):
                        result = worker.main(payload)
                    self.assertEqual(result["code"], "GAPS")
                    self.assertEqual(result["gaps"], pending)
                    upload.assert_not_called()
                    self.assertEqual(client.workflow.creates, 0)
                    self.assertFalse(state_path.exists())

                for result in (worker.main(payload), worker.main(readback)):
                    self.assertTrue(result["verified"])
                    self.assertTrue(result["oaSaved"])
                    self.assertFalse(result["businessComplete"])
                    self.assertEqual(result["status"], "draft_saved_incomplete")
                    self.assertEqual(result["pendingItems"], pending)
                upload.assert_called_once()
                self.assertEqual(client.workflow.creates, 1)

                client.workflow.corrupt = True
                self.assertEqual(worker.main(readback)["code"], "VERIFY_FAILED")
                client.workflow.corrupt = False
                state = worker.read_state(state_path)
                legacy = {key: value for key, value in state.items() if key != "creation"}
                write_job(state_path, legacy)
                self.assertEqual(worker.main(readback)["code"], "VERIFY_FAILED")
                write_job(state_path, state)
                revision = worker.main({
                    **readback, "operation": "revise", "intake": {"payment": {**PAYMENT, "bank": "另一个测试银行"}},
                })
                self.assertTrue(revision["verified"])
                self.assertEqual(revision["pendingItems"], pending)
                self.assertEqual(worker.main(readback)["pendingItems"], pending)
                self.assertEqual(client.workflow.creates, 1)
                upload.assert_called_once()

    def test_expense_schema_drift_blocks_upload_create_and_revision(self):
        for workflow, module in (
            ("oa-travel-expense", travel_expense), ("oa-reception-expense", reception_expense),
        ):
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as directory:
                job = Path(directory)
                client, payload = self.run_fixture(workflow, job)
                if workflow == "oa-travel-expense":
                    attachment = job / "receipt.txt"
                    attachment.write_text("测试附件", encoding="utf-8")
                    payload["materials"] = [{"path": str(attachment), "kind": "attachment"}]

                rows = client.workflow._request("GET", "/workflow/v2/getFieldById", params={"id": module.FORM_ID})["formFields"]
                deleted = [{**rows[0], "delete": True}, *rows[1:]]
                drift_cases = [rows[1:], deleted, [*rows, rows[0]]]
                if workflow == "oa-reception-expense":
                    drift_cases.append([{**rows[0], "dataKey": "differentField"}, *rows[1:]])
                state_path = job / "desktop-job.json"
                with patch.object(worker, "configure", return_value=client), patch(
                    "oa_cli.person.get_client", return_value=client,
                ), patch.dict(os.environ), patch.object(client.invoice, "upload_file", wraps=client.invoice.upload_file) as upload:
                    for drift in drift_cases:
                        with patch.object(client.workflow, "_request", return_value={"formFields": drift}):
                            with self.assertRaisesRegex(worker.WorkerFailure, "ENVIRONMENT_SCHEMA_UNVERIFIED"):
                                worker.main(payload)
                        upload.assert_not_called()
                        self.assertEqual(client.workflow.creates, 0)
                        self.assertFalse(state_path.exists())

                    self.assertTrue(worker.main(payload)["verified"])
                    upload.assert_called_once()
                    state = state_path.read_bytes()
                    with patch.object(client.workflow, "_request", return_value={"formFields": deleted}):
                        with self.assertRaisesRegex(worker.WorkerFailure, "ENVIRONMENT_SCHEMA_UNVERIFIED"):
                            worker.main({
                                **payload, "operation": "revise", "materials": [],
                                "intake": {"payment": {**PAYMENT, "bank": "另一个测试银行"}},
                            })
                    self.assertEqual(client.workflow.patches, [])
                    self.assertEqual(client.workflow.creates, 1)
                    self.assertEqual(state_path.read_bytes(), state)

    def test_real_runners_create_once_and_recover_read_only(self):
        for workflow in INTAKES:
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as directory:
                client, payload = self.run_fixture(workflow, Path(directory))
                with patch.object(worker, "configure", return_value=client), patch(
                    "oa_cli.person.get_client", return_value=client,
                ), patch.dict(os.environ):
                    result = worker.main(payload)
                    self.assertTrue(result["ok"], result)
                    self.assertTrue(result["oaSaved"])
                    self.assertEqual(result["requestId"], DRAFT_ID)
                    self.assertTrue(worker.main(payload)["verified"])
                    self.assertTrue(worker.main({
                        **payload, "operation": "readback", "intake": {}, "materials": [],
                    })["verified"])
                    self.assertEqual(client.workflow.creates, 1)
                    self.assertGreaterEqual(client.workflow.reads, 3)
                    with self.assertRaisesRegex(worker.WorkerFailure, "STATE_CONFLICT"):
                        worker.main({**payload, "intake": {**payload["intake"], "reason": "changed"}})

    def test_lost_create_response_recovers_the_exact_draft_without_writes(self):
        for workflow in INTAKES:
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                client, payload = self.run_fixture(workflow, root, timeout=True)
                title_key = "request_name" if workflow == "oa-business-travel-application" else "title"
                payload["intake"][title_key] = "预期 OA 标题"
                readback = {**payload, "operation": "readback", "intake": {}, "materials": []}

                def assert_create_intent():
                    state = worker.read_state(root / "desktop-job.json")
                    self.assertEqual(state["write"], "create_request")
                    self.assertEqual(state["creation"]["form"], client.workflow.arguments["form_data"])
                    self.assertEqual(state["creation"]["title"], client.workflow.arguments["requestname"])
                    self.assertRegex(state["creation"]["title"], r"^预期 OA 标题 \[HQ-[0-9a-f]{32}\]$")

                client.workflow.before_create = assert_create_intent
                with patch.object(worker, "configure", return_value=client), patch(
                    "oa_cli.person.get_client", return_value=client,
                ), patch.dict(os.environ):
                    for _ in range(2):
                        with self.assertRaisesRegex(worker.WorkerFailure, "CREATION_UNCERTAIN"):
                            worker.main(payload)
                    self.assertEqual(client.workflow.creates, 1)
                    self.assertEqual(client.workflow.recovery_queries, 0)
                    old = {**client.workflow.creation_list_row(), "requestid": "9000", "requestname": "预期 OA 标题"}
                    client.workflow.recovery_pages = [[old], [{"workflowBaseInfo": client.workflow.creation_list_row()}]]
                    result = worker.main(readback)
                    self.assertTrue(result["verified"], result)
                    self.assertEqual(result["requestId"], DRAFT_ID)
                    self.assertEqual(client.workflow.recovery_queries, 3)
                    self.assertTrue(worker.main(readback)["verified"])
                    self.assertEqual(client.workflow.recovery_queries, 3)
                    self.assertEqual(client.workflow.creates, 1)
                    self.assertEqual(client.workflow.patches, [])

    def test_returned_create_id_recovers_after_intake_write_fails_and_oa_renames_draft(self):
        from oa_cli import draft_verification

        atomic_json = draft_verification.atomic_json
        for workflow in INTAKES:
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                job = root / "intake.json"
                state_path = root / "desktop-job.json"
                client, payload = self.run_fixture(workflow, root)
                client.workflow.detail_title = "OA 生成的标题"
                readback = {**payload, "operation": "readback", "intake": {}, "materials": []}

                def interrupt_intake_write(path, data):
                    if path == job and worker.request_id(data):
                        self.assertEqual(worker.read_state(state_path)["returnedRequestId"], DRAFT_ID)
                        self.assertIsNone(worker.request_id(worker.read_state(job)))
                        raise OSError("fixture intake write interrupted")
                    atomic_json(path, data)

                with patch.object(worker, "configure", return_value=client), patch(
                    "oa_cli.person.get_client", return_value=client,
                ), patch.dict(os.environ):
                    with patch.object(draft_verification, "atomic_json", interrupt_intake_write):
                        first = worker.main(payload)
                    self.assertEqual(first, {"ok": False, "code": "READBACK_UNCERTAIN", "requestId": DRAFT_ID})
                    self.assertEqual(client.workflow.reads, 0)
                    self.assertEqual(worker.main(payload), first)
                    journal = job.read_bytes()
                    state = state_path.read_bytes()

                    with patch.object(client.workflow, "get_workflow_request", side_effect=TimeoutError):
                        self.assertEqual(worker.main(readback), first)
                    for field, mismatch in (("detail_operator", "101"), ("corrupt", True), ("submitted", True)):
                        with self.subTest(field=field), patch.object(client.workflow, field, mismatch):
                            failed = worker.main(readback)
                            self.assertEqual(failed["code"], "VERIFY_FAILED")
                            self.assertFalse(failed["oaSaved"])
                            self.assertEqual(job.read_bytes(), journal)
                            self.assertEqual(state_path.read_bytes(), state)
                    self.assertEqual(worker.main(readback)["requestId"], DRAFT_ID)
                    self.assertEqual(worker.request_id(worker.read_state(job)), DRAFT_ID)
                    self.assertTrue(worker.main(readback)["verified"])
                    self.assertTrue(worker.main(payload)["verified"])
                    self.assertEqual(client.workflow.recovery_queries, 0)
                    self.assertEqual(client.workflow.creates, 1)
                    self.assertEqual(client.workflow.patches, [])

                    atomic_json(job, {**worker.read_state(job), "requestId": "9002"})
                    reads = client.workflow.reads
                    with self.assertRaisesRegex(worker.WorkerFailure, "INVALID_JOB_STATE"):
                        worker.main(readback)
                    self.assertEqual(client.workflow.reads, reads)

    def test_create_receipt_requires_success_and_unambiguous_positive_id(self):
        from oa_sdk.api.workflow.models import CreateRequestResponse

        response = CreateRequestResponse.model_validate({"message": {"errcode": "0", "requestId": DRAFT_ID}})
        self.assertEqual(worker.create_response_id(response), DRAFT_ID)
        for response in (
            {"message": {"errcode": "8", "requestId": DRAFT_ID}},
            {"message": {"requestId": DRAFT_ID}, "requestId": "9002"},
            {"message": {"requestId": True}},
            {"message": {"requestId": "0"}},
        ):
            with self.subTest(response=response), self.assertRaisesRegex(worker.WorkerFailure, "CREATION_UNCERTAIN"):
                worker.create_response_id(response)

    def test_create_recovery_preserves_state_until_lookup_and_detail_are_unambiguous(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client, payload = self.run_fixture("oa-business-travel-application", root, timeout=True)
            readback = {**payload, "operation": "readback", "intake": {}, "materials": []}
            with patch.object(worker, "configure", return_value=client), patch(
                "oa_cli.person.get_client", return_value=client,
            ):
                with self.assertRaisesRegex(worker.WorkerFailure, "CREATION_UNCERTAIN"):
                    worker.main(payload)
                journal = (root / "intake.json").read_bytes()
                state = (root / "desktop-job.json").read_bytes()
                row = client.workflow.creation_list_row()
                cases = (
                    ([], "100", False, False),
                    ([[row], [{**row, "requestid": "9002"}]], "100", False, False),
                    ([[row]] + [[{**row, "requestid": str(9100 + page), "requestname": "older"}]
                               for page in range(4)], "100", False, False),
                    ([[row]], "101", False, False),
                    ([[row]], "100", True, False),
                    ([[row]], "100", False, True),
                )
                for pages, operator, corrupt, submitted in cases:
                    client.workflow.recovery_pages = pages
                    client.workflow.detail_operator = operator
                    client.workflow.corrupt = corrupt
                    client.workflow.submitted = submitted
                    with self.assertRaisesRegex(worker.WorkerFailure, "CREATION_UNCERTAIN"):
                        worker.main(readback)
                    self.assertEqual((root / "intake.json").read_bytes(), journal)
                    self.assertEqual((root / "desktop-job.json").read_bytes(), state)
                with patch.object(client.workflow, "my_list", side_effect=TimeoutError):
                    with self.assertRaisesRegex(worker.WorkerFailure, "CREATION_UNCERTAIN"):
                        worker.main(readback)
                client.workflow.submitted = False
                client.workflow.detail_title = "different title"
                with self.assertRaisesRegex(worker.WorkerFailure, "CREATION_UNCERTAIN"):
                    worker.main(readback)
                self.assertEqual((root / "intake.json").read_bytes(), journal)
                self.assertEqual((root / "desktop-job.json").read_bytes(), state)
                self.assertEqual(client.workflow.creates, 1)

    def test_title_reserves_recovery_reference_without_truncating_the_supplied_title(self):
        workflow = "travel_application_flow"
        suffix = worker.CREATION_TITLE_SUFFIX.format("0" * 32)
        title = "长" * (worker.CREATION_TITLE_LIMIT - len(suffix))
        self.assertEqual(worker.draft_title(workflow, {"request_name": title}), title)
        with self.assertRaisesRegex(worker.WorkerFailure, "DRAFT_TITLE_TOO_LONG"):
            worker.draft_title(workflow, {"request_name": title + "长"})

    def test_revises_only_fields_on_same_verified_draft_in_all_four_workflows(self):
        corrected_payment = {**PAYMENT, "bank": "另一个测试银行", "account": "00004567"}
        revisions = {
            "oa-business-travel-application": {"city": {"index": 1, "name": "石家庄市"}},
            "oa-home-travel-expense": {"payment": corrected_payment, "home": "石家庄市"},
            "oa-travel-expense": {"payment": corrected_payment},
            "oa-reception-expense": {"payment": corrected_payment},
        }
        for workflow, correction in revisions.items():
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                client, payload = self.run_fixture(workflow, root)
                revise = {**payload, "operation": "revise", "intake": correction, "materials": []}
                with patch.object(worker, "configure", return_value=client), patch(
                    "oa_cli.person.get_client", return_value=client,
                ), patch.dict(os.environ):
                    with self.assertRaisesRegex(worker.WorkerFailure, "DRAFT_NOT_FOUND"):
                        worker.main(revise)
                    self.assertTrue(worker.main(payload)["verified"])
                    before = copy.deepcopy(client.workflow.arguments["form_data"]["dataDetails"])
                    state_path = root / "desktop-job.json"
                    original_intake = worker.read_state(root / "intake.json")

                    def verify_journal_before_dispatch():
                        pending = worker.read_state(state_path)["revision"]
                        self.assertTrue(pending["pending"])
                        self.assertEqual(pending["requestId"], DRAFT_ID)

                    client.workflow.before_patch = verify_journal_before_dispatch
                    result = worker.main(revise)
                    self.assertTrue(result["verified"], result)
                    self.assertTrue(result["oaSaved"])
                    self.assertEqual(result["requestId"], DRAFT_ID)
                    self.assertFalse(result["businessComplete"])
                    self.assertNotIn(corrected_payment["account"], str(result))
                    self.assertEqual(len(client.workflow.patches), 1)
                    changed = client.workflow.patches[0]
                    self.assertEqual(len(changed), (2 if "payment" in correction else 0) + (1 if "home" in correction or "city" in correction else 0))
                    self.assertEqual(client.workflow.creates, 1)
                    self.assertEqual(result["draftUrl"], f"http://test.invalid/sp/workflow/flowpage/view/{DRAFT_ID}")
                    persisted = worker.read_state(root / "intake.json")
                    self.assertEqual(worker.request_id(persisted), DRAFT_ID)
                    self.assertEqual(persisted.get("payment"), original_intake.get("payment"))
                    self.assertFalse(worker.read_state(state_path)["revision"]["pending"])
                    actual = client.workflow.arguments["form_data"]["dataDetails"]
                    untouched = {(row["fieldId"], row.get("dataIndex")) for row in changed}
                    self.assertEqual(
                        [row for row in actual if (row["fieldId"], row.get("dataIndex")) not in untouched],
                        [row for row in before if (row["fieldId"], row.get("dataIndex")) not in untouched],
                    )
                    self.assertTrue(worker.main({**revise, "operation": "readback", "intake": {}})["verified"])
                    self.assertEqual(worker.main(revise)["code"], "REVISION_NO_CHANGE")
                    self.assertEqual(len(client.workflow.patches), 1)
                    client.workflow.corrupt = True
                    self.assertEqual(worker.main(revise)["code"], "VERIFY_FAILED")
                    self.assertEqual(len(client.workflow.patches), 1)

    def test_revision_recovers_lost_response_via_full_readback_and_never_replays(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client, payload = self.run_fixture("oa-business-travel-application", root)
            revise = {**payload, "operation": "revise", "intake": {"city": {"index": 1, "name": "石家庄市"}}}
            readback = {**revise, "operation": "readback", "intake": {}}
            with patch.object(worker, "configure", return_value=client), patch(
                "oa_cli.person.get_client", return_value=client,
            ):
                self.assertTrue(worker.main(payload)["verified"])
                client.workflow.defer_patch = True
                self.assertEqual(worker.main(revise)["code"], "SAVE_UNCERTAIN")
                self.assertEqual(worker.main(revise)["code"], "SAVE_UNCERTAIN")
                self.assertEqual(worker.main(readback)["code"], "SAVE_UNCERTAIN")
                self.assertEqual(len(client.workflow.patches), 1)
                client.workflow.apply_patch(client.workflow.pending_patch)
                client.workflow.corrupt = True
                self.assertEqual(worker.main(readback)["code"], "SAVE_UNCERTAIN")
                self.assertTrue(worker.read_state(root / "desktop-job.json")["revision"]["pending"])
                client.workflow.corrupt = False
                self.assertTrue(worker.main(readback)["verified"])
                self.assertFalse(worker.read_state(root / "desktop-job.json")["revision"]["pending"])
                self.assertEqual(client.workflow.creates, 1)
                self.assertEqual(len(client.workflow.patches), 1)

    def test_revision_rejects_injected_ids_new_rows_and_nonpending_draft(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client, payload = self.run_fixture("oa-business-travel-application", root)
            revise = {**payload, "operation": "revise"}
            with patch.object(worker, "configure", return_value=client), patch(
                "oa_cli.person.get_client", return_value=client,
            ):
                self.assertTrue(worker.main(payload)["verified"])
                with self.assertRaisesRegex(worker.WorkerFailure, "INVALID_REVISION_FIELDS"):
                    worker.main({**revise, "intake": {"requestId": DRAFT_ID, "city": {"index": 1, "name": "石家庄市"}}})
                with self.assertRaisesRegex(worker.WorkerFailure, "REVISION_ITINERARY_ROW_REQUIRED"):
                    worker.main({**revise, "intake": {"city": {"index": 2, "name": "石家庄市"}}})
                client.workflow.submitted = True
                result = worker.main({**revise, "intake": {"city": {"index": 1, "name": "石家庄市"}}})
                self.assertFalse(result["ok"])
                self.assertEqual(client.workflow.patches, [])
                self.assertEqual(client.workflow.creates, 1)

    def test_mismatched_readback_is_not_a_saved_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            client, payload = self.run_fixture("oa-business-travel-application", Path(directory), corrupt=True)
            with patch.object(worker, "configure", return_value=client), patch(
                "oa_cli.person.get_client", return_value=client,
            ):
                result = worker.main(payload)
                self.assertFalse(result["ok"], result)
                self.assertEqual(result["code"], "VERIFY_FAILED")
                self.assertNotIn("oaSaved", result)
                self.assertEqual(client.workflow.creates, 1)

    def test_missing_travel_binding_stops_before_oa_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            client, payload = self.run_fixture("oa-travel-expense", Path(directory))
            payload["configuration"].pop("travelWorkflowBinding")
            with patch.object(worker, "configure", return_value=client), patch.object(
                worker, "find_operator", side_effect=AssertionError("unexpected OA call"),
            ):
                with self.assertRaisesRegex(worker.WorkerFailure, "ENVIRONMENT_SCHEMA_UNVERIFIED"):
                    worker.main(payload)
            self.assertEqual(client.workflow.creates, 0)

    def test_home_invoice_requires_the_deployment_source_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            client, payload = self.run_fixture("oa-home-travel-expense", path)
            invoice = path / "invoice.txt"
            invoice.write_text("测试车票", encoding="utf-8")
            payload["materials"] = [{"path": str(invoice), "kind": "invoice"}]
            with patch.object(worker, "configure", return_value=client), patch(
                "oa_cli.person.get_client", return_value=client,
            ):
                with self.assertRaisesRegex(worker.WorkerFailure, "INVOICE_SOURCE_CONFIG_REQUIRED"):
                    worker.main(payload)
                self.assertEqual(client.workflow.creates, 0)
                payload["configuration"]["homeInvoiceSourceFlag"] = 13
                result = worker.main(payload)
                self.assertTrue(result["verified"], result)
                self.assertEqual(client.workflow.creates, 1)

    def test_reception_associates_each_line_with_its_original_invoice(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            client, payload = self.run_fixture("oa-reception-expense", path)
            note = path / "support.txt"
            note.write_text("测试说明", encoding="utf-8")
            second_invoice = path / "second-invoice.txt"
            second_invoice.write_text("第二张测试发票", encoding="utf-8")
            payload["materials"].extend([
                {"path": str(note), "kind": "attachment"},
                {"path": str(second_invoice), "kind": "invoice"},
            ])
            verified_invoices = []
            verify_invoice = client.invoice.valid_invoice
            employee_queries = []
            query_employee = client.person.query_employee

            def track_verification(**kwargs):
                verified_invoices.append(kwargs["info_id"])
                return verify_invoice(**kwargs)

            def track_employee_queries(**kwargs):
                employee_queries.append(kwargs)
                return query_employee(**kwargs)

            client.invoice.valid_invoice = track_verification
            client.person.query_employee = track_employee_queries
            with patch.object(worker, "configure", return_value=client), patch(
                "oa_cli.person.get_client", return_value=client,
            ):
                for lines in (
                    [],
                    [{"materialIndex": 1}, {"materialIndex": 1}],
                    [{"materialIndex": 1}, {"materialIndex": 2}],
                    [{"materialIndex": 1}, {"materialIndex": 9}],
                ):
                    payload["intake"]["lines"] = lines
                    with self.assertRaisesRegex(worker.WorkerFailure, "INVOICE_LINE_BINDING_REQUIRED"):
                        worker.main(payload)
                self.assertEqual(client.workflow.creates, 0)
                self.assertFalse(verified_invoices)
                self.assertFalse(employee_queries)
                payload["intake"]["lines"] = [
                    {"materialIndex": 3, "amount": "50.00"},
                    {"materialIndex": 1},
                ]
                with patch.dict(os.environ):
                    check = worker.main({**payload, "operation": "check"})
                self.assertTrue(check["ok"], check)
                self.assertIn("lines[0].infoId", check["deferred"])
                self.assertEqual([item["materialIndex"] for item in check["materials"]], [1, 2, 3])
                self.assertEqual(client.workflow.creates, 0)
                result = worker.main(payload)
                self.assertTrue(result["verified"], result)
                details = client.workflow.arguments["form_data"]["dataDetails"]
                links = [item["dataOptions"][0]["optionId"] for item in details
                         if item["fieldId"] == reception_expense.FIELDS["xgfp"]]
                self.assertEqual(links, ["702", "701"])
                self.assertEqual(verified_invoices, ["701", "702"])
                self.assertTrue(worker.main({
                    **payload, "operation": "readback", "intake": {}, "materials": [],
                })["verified"])
                self.assertEqual(client.workflow.creates, 1)

    def test_check_rejects_identity_override_and_outside_material(self):
        with tempfile.TemporaryDirectory() as directory:
            _, payload = self.run_fixture("oa-home-travel-expense", Path(directory))
            payload["operation"] = "check"
            with self.assertRaisesRegex(worker.WorkerFailure, "INVALID_BUSINESS_FIELDS"):
                worker.main({**payload, "intake": {"userid": "123"}})
            with self.assertRaisesRegex(worker.WorkerFailure, "MATERIAL_SOURCE_INVALID"):
                worker.main({**payload, "materials": [{"path": str(__file__), "kind": "invoice"}]})


if __name__ == "__main__":
    unittest.main()
