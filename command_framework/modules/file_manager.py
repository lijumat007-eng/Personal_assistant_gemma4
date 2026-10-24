"""Workspace-confined filesystem operations shared by API and agent."""
import hashlib
import io
import os
from pathlib import Path
import re
import tempfile
import threading
import uuid


class FileManager:
    def __init__(self):
        self.project_root = str(Path(__file__).resolve().parents[2])
        self.working_dir = self.project_root
        self.notes_dir = str(Path(self.project_root) / 'notes')
        self._lock = threading.RLock()

    def set_working_dir(self, path):
        with self._lock:
            candidate = Path(path.strip() if path and path.strip() else self.project_root).resolve()
            if not candidate.is_dir():
                raise FileNotFoundError('Workspace must be an existing directory.')
            protected = [os.environ.get('SYSTEMROOT', 'C:/Windows'), 'C:/Program Files',
                         'C:/Program Files (x86)', 'C:/ProgramData']
            if os.name == 'nt' and any(candidate == Path(p).resolve() or
                    Path(p).resolve() in candidate.parents for p in protected):
                raise PermissionError('System directories cannot be used as workspaces.')
            if candidate == Path(candidate.anchor):
                raise PermissionError('A filesystem root cannot be used as a workspace.')
            self.working_dir = str(candidate)
            return self.working_dir

    def get_working_dir(self):
        return self.working_dir

    def _resolve_path(self, path):
        candidate = Path(path)
        return str((candidate if candidate.is_absolute() else Path(self.working_dir) / candidate).resolve())

    def _is_within_project(self, path):
        try:
            root, target = Path(self.working_dir).resolve(), Path(path).resolve()
            return target == root or root in target.parents
        except (ValueError, OSError, RuntimeError):
            return False

    def _checked(self, path):
        target = Path(self._resolve_path(path))
        if not self._is_within_project(target):
            raise PermissionError('Access to that path is not allowed.')
        for part in target.relative_to(Path(self.working_dir).resolve()).parts:
            if part.lower() in {'key.txt', 'aws_pass.txt', '.env', '.git', '.jarvis-backups'}:
                raise PermissionError('Access to private workspace data is not allowed.')
        return target

    def _safe_name(self, name, default_ext='.txt'):
        if not name or name in {'.', '..'} or re.search(r'[<>:"/\\|?*\x00-\x1f]', name):
            raise ValueError('Specify a valid filename without directory separators.')
        if name.endswith((' ', '.')) or re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', name):
            raise ValueError('Reserved or invalid filename.')
        if default_ext == '.xlsx' and not name.lower().endswith('.xlsx'):
            name += '.xlsx'
        elif '.' not in name and name not in {'Dockerfile', 'Makefile', 'LICENSE'}:
            name += default_ext
        return name

    def _file(self, filename, folder=None, extension='.txt'):
        return self._checked(str(Path(folder or '') / self._safe_name(filename, extension)))

    def create_note(self, filename, content, folder=None):
        with self._lock:
            target = self._file(filename, folder)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('x', encoding='utf-8') as stream:
                stream.write(content if content is not None else '')
            return f"File created: '{target.relative_to(Path(self.working_dir))}'."

    def read_note(self, filename='', folder=None):
        with self._lock:
            if not filename:
                directory = self._checked(folder or '')
                candidates = [p for p in directory.iterdir() if p.is_file() and p.suffix in {'.txt', '.md'}
                              and p.name.lower() not in {'key.txt', 'aws_pass.txt'}]
                if not candidates:
                    raise FileNotFoundError('No text files found in the workspace.')
                target = self._checked(str(max(candidates, key=lambda p: p.stat().st_mtime)))
            else:
                target = self._file(filename, folder)
            return f"Here is '{target.name}':\n{target.read_text(encoding='utf-8')}"

    def create_folder(self, path):
        with self._lock:
            if not path:
                raise ValueError('Please specify a folder path.')
            target = self._checked(path)
            target.mkdir(parents=True, exist_ok=True)
            return f"Folder created: '{target.relative_to(Path(self.working_dir))}'."

    def list_files(self, path=''):
        with self._lock:
            target = self._checked(path or '')
            entries = [p.name for p in target.iterdir() if p.name.lower() not in
                       {'key.txt', 'aws_pass.txt', '.env', '.git', '.jarvis-backups'}]
            return f"Files in '{target.name}': " + ', '.join(sorted(entries))

    def create_excel(self, filename, headers, rows, folder=None):
        import openpyxl
        with self._lock:
            target = self._file(filename, folder, '.xlsx')
            wb = openpyxl.Workbook()
            if headers:
                wb.active.append(headers)
            for row in rows:
                wb.active.append(list(row))
            buffer = io.BytesIO()
            wb.save(buffer)
            wb.close()
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as stream:
                stream.write(buffer.getvalue())
            return f"Excel spreadsheet created: '{target.name}' with {len(rows)} rows."

    def modify_note(self, filename, find_text=None, replace_text=None, append_text=None,
                    folder=None, expected_hash=None):
        with self._lock:
            target = self._file(filename, folder)
            original = target.read_bytes()
            digest = hashlib.sha256(original).hexdigest()
            if expected_hash is not None and expected_hash != digest:
                raise FileExistsError('File changed since it was reviewed; read it again before editing.')
            content = original.decode('utf-8')
            if find_text and replace_text is not None:
                if find_text not in content:
                    raise ValueError('Requested text was not found; file left unchanged.')
                content = content.replace(find_text, replace_text)
            if append_text:
                content += ('\n' if content and not content.endswith('\n') else '') + append_text
            if content.encode('utf-8') == original:
                return 'No changes requested; file left unchanged.'
            backup_dir = Path(self.working_dir) / '.jarvis-backups'
            if backup_dir.is_symlink() or (hasattr(backup_dir, 'is_junction') and backup_dir.is_junction()):
                raise PermissionError('Backup directory cannot be a filesystem link.')
            backup_dir.mkdir(exist_ok=True)
            backup = backup_dir / f'{uuid.uuid4().hex}.bak'
            with backup.open('xb') as stream:
                stream.write(original)
            fd, temporary = tempfile.mkstemp(prefix='.jarvis-', dir=target.parent)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8', newline='') as stream:
                    stream.write(content)
                if target.read_bytes() != original:
                    raise FileExistsError('File changed during editing; update cancelled.')
                os.replace(temporary, target)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            return f"File '{target.name}' modified. Backup: '.jarvis-backups/{backup.name}'."

    def delete_note(self, filename, folder=None):
        with self._lock:
            target = self._file(filename, folder)
            target.unlink()
            return f"File '{target.name}' deleted."
