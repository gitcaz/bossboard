"""Build a v2.1 sample DB with v2.1's own CLI, then replace its built-in seed (the owner's personal projects/tasks)
with generic sample data so nothing personal ends up in tests, screenshots or the public repo.

    python3 tests/v2_fixture.py /tmp/v2.db      (env BOSSBOARD_V2 = path of v2.1 bossboard.py)
"""
import os, re, sqlite3, subprocess, sys
from pathlib import Path

V2 = Path(os.environ.get("BOSSBOARD_V2", "/workspace/bossboard/bossboard.py"))
FORBIDDEN = re.compile(r"unitstream|buzz|inferenceinfra|oci1|oracle|muri|fridge|monitor|balcony|laundry|printout|"
                       r"cloudflare|ollama|llama|gemini|grok|chatgpt", re.I)
TASKS = ["Water the plants", "Sort the mail", "Charge the laptop", "Close the windows", "Take trash out", "Pack the charger"]


def make(db):
    env = dict(os.environ, BOSSBOARD_DB=str(db))

    def v2(*a):
        subprocess.run([sys.executable, str(V2)] + [str(x) for x in a], env=env, check=True, stdout=subprocess.DEVNULL)
    v2("init")
    v2("update-project", "1", "--name", "Website", "--description", "Sample umbrella project.", "--owner", "user",
       "--status", "active", "--notes", "", "--by", "fixture")
    v2("update-project", "2", "--name", "Chatbot", "--description", "Sample chatbot project.", "--owner", "codex",
       "--status", "in progress", "--notes", "Sample notes.", "--by", "fixture")
    v2("update-project", "3", "--name", "Gateway", "--description", "Sample API gateway project.", "--owner", "claude",
       "--status", "not started", "--notes", "", "--by", "fixture")
    v2("update-resource", "1", "--name", "vm1", "--provider", "Example Cloud", "--notes",
       "Sample server. Credentials: record WHERE they live, never the secret itself.", "--by", "fixture")
    for i, t in enumerate(TASKS, 1):
        v2("update-task", i, "--title", t, "--by", "fixture")
    con = sqlite3.connect(str(db))
    con.execute("DELETE FROM activity")          # seed + rename history mentions the original names
    con.commit()
    dump = "\n".join(con.iterdump())
    con.close()
    bad = FORBIDDEN.findall(dump)
    if bad:
        raise SystemExit("fixture still contains seed data: %s" % sorted(set(bad)))
    v2("add-list", "Garage", "--by", "fixture")  # one activity entry so the log is not empty
    return db


if __name__ == "__main__":
    make(Path(sys.argv[1]))
