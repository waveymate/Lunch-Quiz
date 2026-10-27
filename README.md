# 🥪 Lunch Quiz

A shuffled list of quiz questions, with answers, for reading out to a group at lunch.

**Live:** https://waveymate.github.io/Lunch-Quiz/

## Using it

- Every visit shuffles the questions. Cards load 20 at a time as you scroll.
- **Filters:** pick difficulties (Easy, Medium, Hard, Very Hard, PhD) and categories. Tapping a group name selects all of its subcategories.
- **Answers switch:** shows or hides every answer at once.
- **✓ Asked:** marks a question as read. It stays hidden on later visits until you press **Reset**.
- **⚑ Report:** removes a question that's wrong or too obscure. Use **Reported questions** at the bottom to copy their IDs so they can be deleted from the bank for good.
- Questions marked "Correct as of …" are about things that can change (records, champions, counts).

Asked and reported questions are saved in your browser only (`localStorage`), so each device keeps its own progress.

## How it's built

Plain HTML, CSS and JavaScript with no build step, hosted on GitHub Pages.

```
index.html, styles.css, app.js
data/categories.json            groups, subcategories, colours, difficulty levels
data/questions/<group>.json     one file per group, only fetched when needed
tools/quiz.py                   checks the bank, adds/removes questions
```

Each question looks like this:

```json
{"id":"q1001","question":"…","answer":"…","difficulty":"Hard","category":"F1","asOf":"2026"}
```

`asOf` is optional. Add it to any fact that could go out of date.

## Adding questions

1. Put the new questions in a JSON file (any name). Each needs `question`, `answer`, `difficulty` and `category`, and `asOf` for time-sensitive facts. Leave out `id`.
2. Run `python tools/quiz.py add new.json`. It assigns IDs, puts each question in the right group file, and **skips anything that duplicates an existing question**. It also lists near-matches for a quick look.
3. Run `python tools/quiz.py check`, then commit and push. The live site updates in about a minute.

**Removing reported questions:** `python tools/quiz.py remove q0123 q0456`

**Recent events / stale facts:** `python tools/quiz.py dated --before 2026` lists time-sensitive questions due a re-check.

## Adding a category

Add the name to a group's `categories` list in `data/categories.json`. To add a whole new group, add an entry with an `id`, `name`, `hue` (0–360 for its badge colour) and `categories`, plus an empty `data/questions/<id>.json` containing `[]`. The filter badges are built from this file, so no code changes are needed.
