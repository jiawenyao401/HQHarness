"""Offline smoke test for the actual relocatable payload and its Python ABI."""

import importlib.metadata
import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(sys.argv[1]).resolve()
XASP = ROOT / "xasp"
sys.path[:0] = [
    str(XASP / "apps/cli/src"),
    str(XASP / "packages/sdk/src"),
    str(ROOT / "site-packages"),
]
PYTHON = [sys.executable, "-I", "-B", "-X", "utf8"]

from oa_cli._desktop_io import exclusive_lock, open_regular  # noqa: E402


def try_lock(path):
    with path.open("a+b") as stream:
        try:
            exclusive_lock(stream.fileno(), wait=False)
        except BlockingIOError:
            return 2
    return 0


if len(sys.argv) == 4 and sys.argv[2] == "try-lock":
    raise SystemExit(try_lock(Path(sys.argv[3])))


def verify_files(scratch):
    from oa_cli.draft_verification import write_job
    from oa_cli.expense_journal import atomic_json

    state = scratch / "状态.json"
    atomic_json(state, {"stage": "准备"})
    write_job(state, {"stage": "已保存"})
    assert json.loads(state.read_text()) == {"stage": "已保存"}
    with os.fdopen(open_regular(state), "rb") as stream:
        assert "已保存".encode() in stream.read()

    link = scratch / "redirected.json"
    try:
        link.symlink_to(state)
    except OSError as error:
        if os.name != "nt" or getattr(error, "winerror", None) != 1314:
            raise
    else:
        try:
            os.close(open_regular(link))
        except OSError:
            pass
        else:
            raise AssertionError("accepted a symbolic link")
    if os.name == "nt":
        try:
            os.close(open_regular(str(state) + ":alternate"))
        except OSError:
            pass
        else:
            raise AssertionError("accepted an alternate stream path")

    path = scratch / "state.lock"
    command = [*PYTHON, str(Path(__file__).resolve()), str(ROOT), "try-lock", str(path)]
    with path.open("a+b") as stream:
        exclusive_lock(stream.fileno())
        assert subprocess.run(command, timeout=10, check=False).returncode == 2
    assert subprocess.run(command, timeout=10, check=False).returncode == 0


def verify_multipart(scratch):
    import httpx
    from oa_sdk._config import OaConfig
    from oa_sdk._transport import HttpTransport
    from oa_sdk.api.invoice._constants import PATH_UPLOAD_COMMON_FILE, PATH_UPLOAD_INVOICE_FILE
    from oa_sdk.api.invoice.service import InvoiceService

    class TokenStore:
        def get_valid_access_token(self):
            return "mock-token"

    def inspect_request(request):
        body = request.read()
        assert request.method == "POST"
        assert request.headers["tenantKey"] == "mock-tenant"
        assert b'filename="fixture.txt"' in body and b"fixture contents" in body
        assert b'name="userid"' in body and b"fixture-user" in body
        if request.url.path == PATH_UPLOAD_COMMON_FILE:
            assert request.url.params["access_token"] == "mock-token"
            assert b'name="module"' in body and b"document" in body
            assert b'name="access_token"' not in body
        else:
            assert request.url.path == PATH_UPLOAD_INVOICE_FILE
            assert "access_token" not in request.url.params
            assert b'name="access_token"' in body and b"mock-token" in body and b'name="ocr"' in body
        return httpx.Response(200, json={"errcode": "0", "data": {"id": "1001"}})

    config = OaConfig("fixture", "fixture", "fixture", base_url="https://fixture.invalid", tenant_key="mock-tenant")
    transport = HttpTransport(config, TokenStore())
    transport._client.close()
    with httpx.Client(base_url=config.base_url, transport=httpx.MockTransport(inspect_request)) as client:
        transport._client = client
        invoice = InvoiceService(config, transport)
        material = scratch / "fixture.txt"
        material.write_text("fixture contents", encoding="utf-8")
        for mode in ["0", "1"]:
            assert invoice.upload_file("fixture-user", material, ocr=mode).data.id == "1001"


def verify_workflows(scratch):
    from oa_cli.expense_materials import extract_material
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=120)
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
    })
    text = DecodedStreamObject()
    text.set_data(b"BT /F1 12 Tf 20 20 Td (OA material fixture) Tj ET")
    page.replace_contents(text)
    material = scratch / "fixture.pdf"
    writer.write(material)

    # An empty user password is used by some issuers to restrict editing.
    # Password-protected files must still fail through both bundled extractors.
    encrypted = [
        (scratch / "empty-password.pdf", "", True),
        (scratch / "protected.pdf", "fixture-password", False),
    ]
    for path, password, readable in encrypted:
        encrypted_writer = PdfWriter(clone_from=material)
        encrypted_writer.encrypt(password, owner_password="fixture-owner", algorithm="AES-256")
        encrypted_writer.write(path)
        facts = extract_material(path)
        if readable:
            assert facts["status"] == "EXTRACTED" and "OA material fixture" in facts["text"], facts
        else:
            assert facts["status"] == "UNREADABLE_LOCAL" and "PDF_ENCRYPTED" in facts["issues"], facts
            assert not facts["text"], facts

    for workflow in (
        "oa-travel-expense",
        "oa-home-travel-expense",
        "oa-reception-expense",
        "oa-business-travel-application",
    ):
        assert (XASP / "skill" / "oa" / workflow / "SKILL.md").is_file()
        materials = [(material, True)]
        if workflow == "oa-travel-expense":
            materials.extend((path, readable) for path, _, readable in encrypted)
        payload = {
            "operation": "check",
            "workflow": workflow,
            "jobDir": str(scratch),
            "intake": {},
            "materials": [{"path": str(path), "kind": "attachment"} for path, _ in materials],
        }
        result = subprocess.run(
            [*PYTHON, str(ROOT / "worker.py")],
            input=json.dumps(payload).encode(), capture_output=True, timeout=15, check=True,
        )
        value = json.loads(result.stdout)
        assert value.get("action") == "check" and value.get("ok") is False and value.get("gaps"), (workflow, value)
        for facts, (_, readable) in zip(value["materials"], materials, strict=True):
            if readable:
                assert facts["status"] == "EXTRACTED" and "OA material fixture" in facts["text"], (workflow, facts)
            else:
                assert facts["status"] == "UNREADABLE_LOCAL" and not facts["text"], (workflow, facts)


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert sys.version.split()[0] == manifest["python"]
    for name, version in manifest["pythonPackages"].items():
        assert importlib.metadata.version(name) == version, name
    from pydantic_core import _pydantic_core

    assert Path(_pydantic_core.__file__).resolve().is_relative_to(ROOT / "site-packages")
    assert not (XASP / ".env").exists()
    scratch = Path(sys.argv[2]).resolve()
    verify_files(scratch)
    verify_multipart(scratch)
    verify_workflows(scratch)


if __name__ == "__main__":
    main()
