"""Install a pinned official Electron runtime in this project, without npm."""
import hashlib
from pathlib import Path
import shutil
import sys
import urllib.request
import zipfile

VERSION = "44.5.1"
ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "runtime"


def install():
    if sys.platform != "win32":
        raise SystemExit("This launcher currently supports Windows x64 only.")
    if (RUNTIME / "electron.exe").exists() and (RUNTIME / "version").read_text().strip() == VERSION:
        print(f"Electron {VERSION} is already installed.")
        return
    if RUNTIME.exists():
        raise SystemExit("An incomplete/different runtime exists. Move that folder aside before retrying.")
    if shutil.disk_usage(ROOT).free < 750 * 1024 * 1024:
        raise SystemExit("The runtime needs at least 750 MB of free disk space during setup.")
    name = f"electron-v{VERSION}-win32-x64.zip"
    base = f"https://github.com/electron/electron/releases/download/v{VERSION}/"
    request = urllib.request.Request(base + "SHASUMS256.txt", headers={"User-Agent": "Jarvis-desktop-setup"})
    with urllib.request.urlopen(request, timeout=45) as response:
        sums = response.read().decode("ascii").splitlines()
    expected = next(line.split()[0] for line in sums if line.split()[-1].lstrip("*") == name)
    archive = ROOT / (name + ".download")
    try:
        print(f"Downloading official Electron {VERSION} (about 151 MB)…", flush=True)
        request = urllib.request.Request(base + name, headers={"User-Agent": "Jarvis-desktop-setup"})
        digest = hashlib.sha256()
        with urllib.request.urlopen(request, timeout=60) as response, archive.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != expected:
            raise SystemExit("Runtime checksum mismatch; nothing was installed.")
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                target = (RUNTIME / member.filename).resolve()
                if not target.is_relative_to(RUNTIME.resolve()):
                    raise SystemExit("Unexpected archive path; nothing was installed.")
            bundle.extractall(RUNTIME)
        if not (RUNTIME / "electron.exe").is_file() or (RUNTIME / "version").read_text().strip() != VERSION:
            raise SystemExit("Runtime did not contain the expected executable/version.")
        print(f"Verified and installed Electron {VERSION} in {RUNTIME}.")
    finally:
        archive.unlink(missing_ok=True)


if __name__ == "__main__":
    install()
