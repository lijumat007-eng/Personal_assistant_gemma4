import hashlib
import importlib
from pathlib import Path
import shutil
import sys
import os
import subprocess
import types
import unittest
import uuid
import json
from unittest.mock import Mock, patch
from command_framework.modules.file_manager import FileManager

class FileSafetyTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parent / ('workspace-' + uuid.uuid4().hex)
        self.root.mkdir()
        self.files = FileManager()
        self.files.set_working_dir(str(self.root))
    def tearDown(self):
        assert self.root.parent == Path(__file__).resolve().parent
        shutil.rmtree(self.root)
    def test_workspace_boundary(self):
        self.assertFalse(self.files._is_within_project(self.files.project_root))
        with self.assertRaises(PermissionError):
            self.files.create_folder('../escape')
    def test_exclusive_creation_and_empty_content(self):
        self.files.create_note('file.tsx', 'original')
        with self.assertRaises(FileExistsError):
            self.files.create_note('file.tsx', 'replacement')
        self.assertEqual((self.root / 'file.tsx').read_text(), 'original')
        self.files.create_note('empty.txt', '')
        self.assertEqual((self.root / 'empty.txt').read_bytes(), b'')
    def test_excel_preservation(self):
        self.files.create_excel('budget', ['Item'], [['apple']])
        original = (self.root / 'budget.xlsx').read_bytes()
        with self.assertRaises(FileExistsError):
            self.files.create_excel('budget', ['Item'], [['pear']])
        self.assertEqual((self.root / 'budget.xlsx').read_bytes(), original)
    def test_missing_read_and_invalid_workspace(self):
        with self.assertRaises(FileNotFoundError):
            self.files.read_note('absent.txt', 'missing')
        self.assertFalse((self.root / 'missing').exists())
        with self.assertRaises(FileNotFoundError):
            self.files.set_working_dir(str(self.root / 'missing'))
        self.assertEqual(self.files.get_working_dir(), str(self.root))
    def test_private_and_invalid_names(self):
        for name in ['key.txt', 'aws_pass.txt', '.env']:
            with self.assertRaises(PermissionError):
                self.files.create_note(name, 'unused')
        for name in ['../bad.txt', 'CON.txt', 'bad:', '..']:
            with self.assertRaises(ValueError):
                self.files.create_note(name, 'unused')
    def test_backup_and_stale_edit(self):
        self.files.create_note('file.txt', 'remove keep')
        with self.assertRaises(FileExistsError):
            self.files.modify_note('file.txt', append_text='extra', expected_hash='stale')
        self.files.modify_note('file.txt', find_text='remove ', replace_text='',
                              expected_hash=hashlib.sha256(b'remove keep').hexdigest())
        self.assertEqual((self.root / 'file.txt').read_text(), 'keep')
        self.assertEqual(next((self.root / '.jarvis-backups').iterdir()).read_bytes(), b'remove keep')
    def test_junction_escape(self):
        if os.name != 'nt':
            self.skipTest('Windows junction test')
        outside = self.root.parent / ('outside-' + uuid.uuid4().hex)
        outside.mkdir()
        link = self.root / 'junction'
        try:
            result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)], capture_output=True)
            if result.returncode:
                self.skipTest('Junction creation unavailable')
            with self.assertRaises(PermissionError):
                self.files.create_note('escape.txt', 'unused', folder='junction')
            self.assertFalse((outside / 'escape.txt').exists())
        finally:
            if link.exists():
                link.rmdir()
            outside.rmdir()

    def test_link_escape(self):
        outside = self.root.parent / ('outside-' + uuid.uuid4().hex)
        outside.mkdir()
        try:
            try:
                (self.root / 'link').symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest('Symlink creation requires Windows privilege.')
            with self.assertRaises(PermissionError):
                self.files.create_note('escape.txt', 'unused', folder='link')
        finally:
            if (self.root / 'link').is_symlink():
                (self.root / 'link').unlink()
            outside.rmdir()

class AgentApprovalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fake_db = types.ModuleType('database')
        fake_db.add_chat_message = Mock()
        cls.modules = patch.dict(sys.modules, {'database': fake_db})
        cls.modules.start()
        cls.module = importlib.import_module('command_framework.agent.agent_graph')
    @classmethod
    def tearDownClass(cls):
        cls.modules.stop()
    def make_agent(self):
        from langchain_core.messages import AIMessage
        agent = self.module.JarvisAgent.__new__(self.module.JarvisAgent)
        agent.active_thread_id = str(uuid.uuid4())
        agent.fallback_llm = None
        agent.llm = Mock()
        calls = [{'name': name, 'args': args, 'id': str(i), 'type': 'tool_call'}
                 for i, (name, args) in enumerate([
                     ('get_time', {}), ('delete_note', {'filename': 'first.txt'}),
                     ('open_app', {'app': 'notepad'}), ('set_timer', {'seconds': 2})])]
        agent.llm.invoke.side_effect = [AIMessage(content='', tool_calls=calls), AIMessage(content='Done')]
        agent._build_graph()
        return agent

    def test_selected_model_and_local_isolation(self):
        local = Mock()
        cloud = Mock()
        with patch.dict(sys.modules, {
            'langchain_ollama': types.SimpleNamespace(ChatOllama=local),
            'langchain_google_genai': types.SimpleNamespace(ChatGoogleGenerativeAI=cloud),
        }):
            agent = self.module.JarvisAgent.__new__(self.module.JarvisAgent)
            agent.provider, agent.model_name = 'ollama', 'qwen2.5:1.5b'
            agent.ollama_host, agent.api_key = 'http://localhost:11434', 'test-key'
            agent._init_models()
            cloud.assert_not_called()
            self.assertEqual(local.call_args.kwargs['model'], 'qwen2.5:1.5b')
            self.assertIsNone(agent.fallback_llm)
            agent.provider, agent.model_name = 'gemini', 'chosen-cloud-model'
            agent._init_models()
            self.assertEqual(cloud.call_args.kwargs['model'], 'chosen-cloud-model')
            self.assertIsNone(agent.fallback_llm)
    def test_approvals_do_not_replay(self):
        agent = self.make_agent()
        tools = {name: Mock() for name in ['get_time', 'delete_note', 'open_app', 'set_timer']}
        for tool in tools.values():
            tool.invoke.return_value = 'completed'
        with patch.object(self.module, 'TOOL_MAP', tools):
            first = agent.process_query('Run test')
            self.assertEqual(first['status'], 'pending_approval')
            self.assertEqual(len(first['steps']), 1)
            self.assertEqual(agent.process_query('Another query')['status'], 'error')
            second = agent.resume_approval(first['approval_id'], True)
            self.assertEqual(second['status'], 'pending_approval')
            self.assertNotEqual(first['approval_id'], second['approval_id'])
            self.assertEqual(agent.resume_approval(first['approval_id'], True)['status'], 'error')
            final = agent.resume_approval(second['approval_id'], True)
            self.assertEqual(final['status'], 'success')
            for tool in tools.values():
                tool.invoke.assert_called_once()
            self.assertEqual(len(final['steps']), 4)
            self.assertEqual(agent.resume_approval(second['approval_id'], True)['status'], 'error')
    def test_edit_preview_and_conflict_after_approval(self):
        from langchain_core.messages import AIMessage
        import command_framework.agent.agent_tools as tool_module
        fixture = FileSafetyTests('test_workspace_boundary')
        fixture.setUp()
        try:
            fixture.files.create_note('file.txt', 'original')
            agent = self.make_agent()
            agent.llm.invoke.side_effect = [AIMessage(content='', tool_calls=[
                {'name':'modify_note', 'args':{'filename':'file.txt','append_text':'extra'}, 'id':'edit', 'type':'tool_call'}
            ]), AIMessage(content='Finished')]
            with patch.object(tool_module, '_files', fixture.files):
                pending = agent.process_query('Append text')
                self.assertEqual(pending['status'], 'pending_approval')
                self.assertIn('+extra', pending['description'])
                (fixture.root / 'file.txt').write_text('external change')
                final = agent.resume_approval(pending['approval_id'], True)
                self.assertEqual((fixture.root / 'file.txt').read_text(), 'external change')
                self.assertIn('changed since it was reviewed', final['steps'][0]['result'])
                self.assertEqual(final['status'], 'error')
                self.assertEqual(final['steps'][0]['status'], 'failed')
        finally:
            fixture.tearDown()

    def test_denial(self):
        agent = self.make_agent()
        tools = {name: Mock() for name in ['get_time', 'delete_note', 'open_app', 'set_timer']}
        for tool in tools.values():
            tool.invoke.return_value = 'completed'
        with patch.object(self.module, 'TOOL_MAP', tools):
            first = agent.process_query('Run test')
            second = agent.resume_approval(first['approval_id'], False)
            final = agent.resume_approval(second['approval_id'], False)
            self.assertEqual(final['status'], 'success')
            tools['delete_note'].invoke.assert_not_called()
            tools['open_app'].invoke.assert_not_called()
            tools['get_time'].invoke.assert_called_once()
            tools['set_timer'].invoke.assert_called_once()

class ApiSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        fake_db = types.ModuleType('database')
        fake_db.add_chat_message = Mock()
        whisper = types.ModuleType('faster_whisper')
        whisper.WhisperModel = Mock()
        with patch.dict(sys.modules, {'database': fake_db, 'faster_whisper': whisper}):
            graph_module = importlib.import_module('command_framework.agent.agent_graph')
            fake_agent = Mock()
            fake_agent.graph.get_state.return_value.next = ()
            with patch.object(graph_module, 'JarvisAgent', return_value=fake_agent):
                cls.server = importlib.import_module('web_server')
        cls.Client = TestClient

    def setUp(self):
        FileSafetyTests.setUp(self)
        self.previous_manager = self.server.file_mgr
        self.server.file_mgr = self.files
        self.client = self.Client(self.server.app, base_url='http://localhost')

    def tearDown(self):
        self.client.close()
        self.server.file_mgr = self.previous_manager
        FileSafetyTests.tearDown(self)

    def test_token_required_even_with_same_origin_header(self):
        response = self.client.get('/api/workspace', headers={'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(response.status_code, 401)
        self.client.get('/')
        self.assertEqual(self.client.get('/api/workspace').status_code, 200)
        self.assertEqual(self.client.post('/api/explorer/create_folder', json={'path':'safe'},
                         headers={'Origin':'https://untrusted.example'}).status_code, 403)
        self.assertEqual(self.client.get('/api/workspace', headers={'Host':'untrusted.example'}).status_code, 400)

    def test_api_errors_preserve_files(self):
        self.client.get('/')
        payload = {'filename':'original.txt', 'content':'original'}
        self.assertEqual(self.client.post('/api/explorer/create_note', json=payload).status_code, 200)
        payload['content'] = 'replacement'
        self.assertEqual(self.client.post('/api/explorer/create_note', json=payload).status_code, 409)
        self.assertEqual((self.root / 'original.txt').read_text(), 'original')
        self.assertEqual(self.client.get('/api/notes/missing.txt').status_code, 404)
        self.assertEqual(self.client.get('/api/notes/key.txt').status_code, 403)
        self.assertEqual(self.client.post('/api/explorer/create_folder', json={'path':'../escape'}).status_code, 403)

    def test_reasoning_selection_credentials_and_rollback(self):
        config_path = self.root / 'reasoning.json'
        config_path.write_text(json.dumps({'llm_provider': 'ollama', 'ollama': {'model_name': 'small:1b'}, 'gemini': {'model_name': 'cloud-model'}}))
        class Agent:
            active_thread_id = 'reasoning-test'
            provider = 'ollama'
            model_name = 'small:1b'
            ollama_host = 'http://localhost:11434'
            api_key = ''
            llm = 'old-model'
            fallback_llm = None
            graph = Mock()
            def _init_models(self):
                self.llm = self.model_name if self.model_name != 'broken' else None
                self.fallback_llm = None
        active = Agent()
        active.config_path = str(config_path)
        active.graph.get_state.return_value.next = ()
        with patch.object(self.server, 'agent', active), patch.object(self.server, 'ollama_models', return_value=[{'name': 'small:1b'}, {'name': 'large:3b'}]):
            self.assertEqual(self.client.get('/api/agent/models').status_code, 401)
            self.client.get('/')
            self.assertEqual(len(self.client.get('/api/agent/models').json()['models']), 2)
            self.assertFalse(self.client.get('/api/agent/options').json()['cloud_key_configured'])
            self.assertEqual(self.client.post('/api/agent/config', json={'provider': 'gemini', 'model_name': 'cloud-model'}).status_code, 400)
            self.assertEqual(self.client.post('/api/agent/config', json={'provider': 'ollama', 'model_name': 'absent'}).status_code, 400)
            response = self.client.post('/api/agent/config', json={'provider': 'ollama', 'model_name': 'large:3b'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(active.model_name, 'large:3b')
            snapshot = config_path.read_text()
            response = self.client.post('/api/agent/config', json={'provider': 'gemini', 'model_name': 'broken', 'api_key': 'test-secret'})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(config_path.read_text(), snapshot)
            self.assertEqual(active.model_name, 'large:3b')
            response = self.client.post('/api/agent/config', json={'provider': 'gemini', 'model_name': 'cloud-model', 'api_key': 'test-secret'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(active.api_key, 'test-secret')
            self.assertNotIn('test-secret', response.text + config_path.read_text() + self.client.get('/api/agent/options').text)
            active.graph.get_state.return_value.next = ('tools',)
            self.assertEqual(self.client.post('/api/agent/config', json={'provider': 'ollama', 'model_name': 'small:1b'}).status_code, 409)

    def test_ollama_discovery_offline_and_empty(self):
        response = Mock()
        response.json.return_value = {'models': []}
        with patch.object(self.server.requests, 'get', return_value=response) as fetch:
            self.assertEqual(self.server.ollama_models('http://localhost:11434/'), [])
            fetch.assert_called_once_with('http://localhost:11434/api/tags', timeout=5)
        with patch.object(self.server.requests, 'get', side_effect=self.server.requests.ConnectionError()):
            with self.assertRaises(self.server.HTTPException) as failure:
                self.server.ollama_models('http://localhost:11434')
            self.assertEqual(failure.exception.status_code, 503)

if __name__ == '__main__':
    unittest.main()
