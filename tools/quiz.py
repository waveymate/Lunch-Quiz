"""Maintain the Lunch Quiz question bank.

Usage:
  python tools/quiz.py check                 Validate every file and flag likely duplicates
  python tools/quiz.py add NEW.json          Add questions (IDs assigned, duplicates skipped)
  python tools/quiz.py remove q0123 q0456    Delete questions (e.g. IDs copied from "Reported")
  python tools/quiz.py move q0001 "Capital Cities" [ID CATEGORY ...]
                                             Recategorise questions (keeps their IDs)
  python tools/quiz.py dated [--before 2026] List time-sensitive questions (those with "asOf")

Categories and keywords in data/blocklist.json are refused by `add` and flagged by `check`.
Every command that changes the bank (and `check`) rewrites data/counts.json, which the app
uses for the numbers on its filter chips.

NEW.json is a JSON array of objects with: question, answer, difficulty, category
(or the short keys q, a, d, c), and optionally asOf ("2026" or "2026-10") for
facts that can change.
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
QUESTIONS = DATA / "questions"
BLOCKLIST_FILE = DATA / "blocklist.json"
COUNTS_FILE = DATA / "counts.json"

REQUIRED = ("id", "question", "answer", "difficulty", "category")
# Batch files for `add` may use these short keys to stay compact.
SHORT_KEYS = {"q": "question", "a": "answer", "d": "difficulty", "c": "category"}
ALLOWED = set(REQUIRED) | {"asOf"}
ID_RE = re.compile(r"^q\d{4,}$")
AS_OF_RE = re.compile(r"^\d{4}(-\d{2})?$")

# Question pairs at or above BLOCK are treated as duplicates; WARN and above are flagged for review.
BLOCK = 0.75
WARN = 0.55

STOPWORDS = set("""
a an the of in on at to for from by with and or is are was were be been which what who whom whose
when where why how that this these those it its as into than then do does did name called known
famous most first one two three s t
""".split())


def load_json(path):
    # utf-8-sig tolerates a BOM if a file was saved by an editor that adds one.
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save_json(path, questions):
    lines = ",\n".join(json.dumps(q, ensure_ascii=False, separators=(",", ":")) for q in questions)
    path.write_text(f"[\n{lines}\n]\n" if questions else "[]\n", encoding="utf-8", newline="\n")


def load_taxonomy():
    cats = load_json(DATA / "categories.json")
    group_of = {c: g["id"] for g in cats["groups"] for c in g["categories"]}
    return cats, group_of


def load_bank(cats):
    return {g["id"]: (load_json(QUESTIONS / f"{g['id']}.json") if (QUESTIONS / f"{g['id']}.json").exists() else [])
            for g in cats["groups"]}


def tokens(text):
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {w for w in words if w not in STOPWORDS}


def similarity(a, b):
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def answer_key(answer):
    head = re.split(r"[(:;,.]", answer, maxsplit=1)[0]
    return " ".join(sorted(tokens(head)))


def validate(cats, group_of, bank):
    errors, seen = [], set()
    for group_id, questions in bank.items():
        for q in questions:
            where = f"{group_id}.json {q.get('id', '?')}"
            missing = [k for k in REQUIRED if not q.get(k)]
            if missing:
                errors.append(f"{where}: missing {', '.join(missing)}")
                continue
            if set(q) - ALLOWED:
                errors.append(f"{where}: unknown fields {sorted(set(q) - ALLOWED)}")
            if not ID_RE.match(q["id"]):
                errors.append(f"{where}: bad id format")
            if q["id"] in seen:
                errors.append(f"{where}: duplicate id")
            seen.add(q["id"])
            if q["difficulty"] not in cats["difficulties"]:
                errors.append(f"{where}: unknown difficulty '{q['difficulty']}'")
            if group_of.get(q["category"]) != group_id:
                errors.append(f"{where}: category '{q['category']}' does not belong in {group_id}.json")
            if "asOf" in q and not AS_OF_RE.match(str(q["asOf"])):
                errors.append(f"{where}: asOf must look like 2026 or 2026-10")
    return errors


def find_similar(question, pool, threshold):
    hits = []
    for other in pool:
        score = similarity(question["question"], other["question"])
        same_answer = (question.get("category") == other.get("category")
                       and answer_key(question["answer"]) == answer_key(other["answer"]))
        if score >= threshold or (same_answer and score >= 0.3):
            hits.append((max(score, BLOCK if same_answer and score >= 0.5 else score), other))
    return sorted(hits, key=lambda h: -h[0])


def all_questions(bank):
    return [q for qs in bank.values() for q in qs]


def load_blocklist():
    if not BLOCKLIST_FILE.exists():
        return set(), []
    data = load_json(BLOCKLIST_FILE)
    return set(data.get("categories", [])), [w.lower() for w in data.get("keywords", [])]


def blocked_reason(q, blocked_cats, blocked_words):
    if q.get("category") in blocked_cats:
        return f"category '{q['category']}' is blocklisted"
    text = f"{q.get('question', '')} {q.get('answer', '')}".lower()
    hit = next((w for w in blocked_words if w in text), None)
    return f"mentions blocklisted term '{hit}'" if hit else None


def write_counts(bank):
    counts = {}
    for q in all_questions(bank):
        counts.setdefault(q["category"], Counter())[q["difficulty"]] += 1
    data = {"total": len(all_questions(bank)),
            "counts": {c: dict(n) for c, n in sorted(counts.items())}}
    COUNTS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")


def save_bank(cats, bank):
    for g in cats["groups"]:
        save_json(QUESTIONS / f"{g['id']}.json", bank[g["id"]])
    write_counts(bank)


def cmd_check():
    cats, group_of = load_taxonomy()
    bank = load_bank(cats)
    errors = validate(cats, group_of, bank)
    blocked_cats, blocked_words = load_blocklist()
    for q in all_questions(bank):
        why = blocked_reason(q, blocked_cats, blocked_words)
        if why:
            errors.append(f"{q['id']}: {why}")
    for e in errors:
        print("ERROR", e)

    everything = all_questions(bank)
    flagged = 0
    for i, q in enumerate(everything):
        for score, other in find_similar(q, everything[i + 1:], WARN):
            flagged += 1
            print(f"SIMILAR {score:.2f}  {q['id']} \"{q['question']}\"\n              {other['id']} \"{other['question']}\"")

    print(f"\n{len(everything)} questions, {len(errors)} errors, {flagged} similar pairs to review")
    by_diff = Counter(q["difficulty"] for q in everything)
    print("By difficulty: " + ", ".join(f"{d} {by_diff.get(d, 0)}" for d in cats["difficulties"]))
    for g in cats["groups"]:
        qs = bank[g["id"]]
        counts = Counter(q["category"] for q in qs)
        empty = [c for c in g["categories"] if not counts.get(c)]
        line = f"  {g['name']}: {len(qs)}"
        if empty:
            line += f"  (empty: {', '.join(empty)})"
        print(line)
    write_counts(bank)
    return 1 if errors else 0


def next_id_number(bank):
    nums = [int(q["id"][1:]) for q in all_questions(bank) if ID_RE.match(q["id"])]
    # New questions start at q1001 so imported IDs (q0001-q0500) keep their own range.
    return max(nums + [1000]) + 1


def cmd_add(path):
    cats, group_of = load_taxonomy()
    bank = load_bank(cats)
    incoming = load_json(Path(path))
    blocked_cats, blocked_words = load_blocklist()
    existing = all_questions(bank)
    n = next_id_number(bank)
    added, skipped, review = [], [], []

    for raw in incoming:
        raw = {SHORT_KEYS.get(k, k): v for k, v in raw.items()}
        q = {k: raw[k] for k in ("question", "answer", "difficulty", "category", "asOf") if raw.get(k)}
        problem = None
        if not all(q.get(k) for k in ("question", "answer", "difficulty", "category")):
            problem = "missing a field"
        elif why := blocked_reason(q, blocked_cats, blocked_words):
            problem = why
        elif q["category"] not in group_of:
            problem = f"unknown category '{q['category']}' (add it to data/categories.json first)"
        elif q["difficulty"] not in cats["difficulties"]:
            problem = f"unknown difficulty '{q['difficulty']}'"
        if problem:
            skipped.append((raw.get("question", "?"), problem))
            continue

        hits = find_similar(q, existing, WARN)
        if hits and hits[0][0] >= BLOCK:
            skipped.append((q["question"], f"duplicate of {hits[0][1]['id']}: \"{hits[0][1]['question']}\""))
            continue

        q = {"id": f"q{n:04d}", **q}
        n += 1
        bank[group_of[q["category"]]].append(q)
        existing.append(q)
        added.append(q)
        if hits:
            review.append((q, hits[0]))

    save_bank(cats, bank)

    print(f"Added {len(added)}, skipped {len(skipped)}")
    for text, why in skipped:
        print(f"  SKIPPED \"{text}\": {why}")
    for q, (score, other) in review:
        print(f"  REVIEW {q['id']} looks a bit like {other['id']} ({score:.2f}): \"{other['question']}\"")
    return 0


def cmd_remove(ids):
    cats, _ = load_taxonomy()
    bank = load_bank(cats)
    wanted = {i.strip(", ") for i in ids if i.strip(", ")}
    removed = []
    for g in cats["groups"]:
        removed += [q for q in bank[g["id"]] if q["id"] in wanted]
        bank[g["id"]] = [q for q in bank[g["id"]] if q["id"] not in wanted]
    save_bank(cats, bank)
    for q in removed:
        print(f"Removed {q['id']}: {q['question']}")
    for missing in sorted(wanted - {q["id"] for q in removed}):
        print(f"Not found: {missing}")
    return 0


def cmd_move(args):
    if len(args) % 2:
        print('Usage: move ID CATEGORY [ID CATEGORY ...]  (quote names with spaces, e.g. "Capital Cities")')
        return 1
    cats, group_of = load_taxonomy()
    bank = load_bank(cats)
    by_id = {q["id"]: (gid, q) for gid, qs in bank.items() for q in qs}
    for qid, category in zip(args[::2], args[1::2]):
        if qid not in by_id:
            print(f"Not found: {qid}")
            continue
        if category not in group_of:
            print(f"Unknown category '{category}' (add it to data/categories.json first)")
            continue
        old_group, q = by_id[qid]
        bank[old_group].remove(q)
        q["category"] = category
        bank[group_of[category]].append(q)
        by_id[qid] = (group_of[category], q)
        print(f"Moved {qid} -> {category}")
    save_bank(cats, bank)
    return 0


def cmd_dated(args):
    before = None
    if "--before" in args:
        before = args[args.index("--before") + 1]
    cats, _ = load_taxonomy()
    dated = [q for q in all_questions(load_bank(cats)) if q.get("asOf")]
    if before:
        dated = [q for q in dated if str(q["asOf"]) < before]
    for q in sorted(dated, key=lambda q: str(q["asOf"])):
        print(f"{q['asOf']:<8} {q['id']}  {q['question']}  ->  {q['answer']}")
    print(f"\n{len(dated)} time-sensitive questions")
    return 0


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd, rest = argv[0], argv[1:]
    if cmd == "check":
        return cmd_check()
    if cmd == "add" and rest:
        return cmd_add(rest[0])
    if cmd == "remove" and rest:
        return cmd_remove(rest)
    if cmd == "move" and rest:
        return cmd_move(rest)
    if cmd == "dated":
        return cmd_dated(rest)
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
