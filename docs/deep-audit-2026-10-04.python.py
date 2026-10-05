from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).resolve().parents[1] / 'tests' / 'test_deep_companion.py'), run_name='__main__')
