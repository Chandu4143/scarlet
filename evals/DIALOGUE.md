# Fixing a dialogue cut

Every thread that changes how Scarlet cuts dialogue follows this, whether it starts from a mistake the editor found
or from an idea. The point is that each fix is checked against every mistake reported before it, not only the one in
front of you, so the cutting gets better overall instead of trading one problem for another.

The ledger lives with the eval data, never in the repository: it holds the editor's words and times.

- `$SCARLET_EVAL_DATA/dialogue/history.md`: what each report was, its cause, what was tried and dropped, what's open.
- `$SCARLET_EVAL_DATA/dialogue/ledger.json`: one entry per reported mistake, each with a check.
- `$SCARLET_EVAL_DATA/dialogue/scoreboard.jsonl`: one row per recorded run of the checks.

`$SCARLET_EVAL_DATA` defaults to `<Scarlet application support>/evals`.

## 1. Read before you change anything

Read `history.md` and run `tsx evals/src/ledger.ts list`. Answer, before writing code:

- Has this happened before? An earlier entry at the same kind of spot may be a regression, not a new problem.
- What touched this code or behavior before, and what was tried and dropped there?
- Is your idea already on the "tried and dropped" list?

## 2. Find the cause, then add the entry

Find where the mistake came from before fixing anything: the run's events, the transcript, the levels, the replay
(see `README.md`). Name its cause, which says where the fix belongs (`docs/skills-and-tools.md`):

- `transcript`: words missing, invented or mistimed.
- `placement`: Scarlet's code put an edge, held, refused or applied a cut wrongly given what the model asked.
- `model`: the model asked for the wrong thing, or kept something it should have cut.
- `eval`: the measurement was wrong, not the edit.
- `flow`: the run did something at the wrong time.

Add an entry to `ledger.json` with the editor's words, the project, run and time, the cause and a check:

- **replay** (free, preferred for `placement`): build a case from the run once
  (`dataset.ts build --project … --from-task … --with-scan --suite regression --id ledger-<name>`) and say what the
  current code must do at the spot, in source seconds of the recording:
  - `plays`: the words the edit plays in a stretch. `accept: ["right", "asked"]` also passes a call whose approval
    plays them.
  - `edge`: where the model's first request near a time places its edge, applied or staged.
  - `notApplied`: nothing in a stretch is taken out without the editor.

  A replay sends the model's own requests from that run through today's planning code, set-aside rounds included.
  It can't show a live re-read of the recording, cuts staged by an earlier save, or a transcript change: use a
  command check for those.
- **command** (free): a unit test with a synthetic fixture that reproduces the mechanism, run by name from the
  repository root (`cd packages/mcp && ../../node_modules/.bin/vitest run src/x.test.ts -t '…'`). Exit 0 passes.
- **trials** (costs model tokens): only model passes can show it. Record what the last trials found in `last`.
- **none**: say why, and what would make it checkable.

Run the new entry on the current code before you fix anything: it should fail. An entry that passes on the code that
made the mistake doesn't check it.

## 3. Fix it

Fix the class of problem at the level the cause names, not the one spot. Follow `docs/AI-AGENTS.md`: the model decides,
Scarlet measures and keeps edits safe, skills hold taste. Prefer removing a tuned rule to adding one.

## 4. Run the checks

```sh
PATH=/Applications/Scarlet.app/Contents/MacOS:$PATH node_modules/.bin/tsx evals/src/ledger.ts check
```

About a minute, no model tokens. It runs every entry and compares with the latest recorded run this checkout builds
on: which entries broke, which now pass, and how far each replayed pass moved overall (cuts applied, held, edges on
speech). A change ships only when:

- its own entry passes,
- no entry marked `fixed` fails (the command exits 1 if one does), and
- any whole-pass movement is explained. A fix for one spot that moves dozens of edges in other passes needs a look at
  those edges before it ships.

**Model passes cost the editor tokens. Never start one without asking.** Ask only when the change alters what the
model reads (prompt, skills, tool descriptions or results) or the entry's cause is `model`, and propose the smallest
run that can answer: a clone of the reported project cut down to the minute around the spot, 4 passes an arm, against
4 on main. Say the expected cost when you ask.

## 5. Score it against the published video

The ledger says whether old mistakes stay fixed. The scorecard says how good the cut is: each scored pass is read
against the video the editor's own editor published from the same recording, and comes down to a percentage for each
thing a dialogue cut has to get right, and one overall figure.

| Factor | 100% means |
|---|---|
| Cut accuracy | Scarlet removed the words the editor removed, and no others |
| Lines kept | every sentence the editor kept is still in |
| No mid-word cuts | no join cuts into a word that is sounding |
| Dead air | as much dead air left as the editor left, no more and no less |
| Cut count | as many cuts as the editor made |
| Space at a cut | at cuts both made, the pause is within 0.1 s of the editor's |
| No restarts left in | no more restarts or doubled words play than in the editor's cut |
| Known mistakes | every spot that went wrong before comes out right, or is asked about |

```sh
# One run, or one pass: its card, and for a single pass what each figure is made of.
node_modules/.bin/tsx evals/src/scorecard.ts <run folder | evaluation.json>
# Main against a change: each factor side by side, and which differences are inside the spread between passes.
node_modules/.bin/tsx evals/src/scorecard.ts <main's run> <the change's run> --labels main,change --ledger
```

A scorecard costs nothing: it reads what `run.ts` already scored, and every run writes its own `scorecard.md`. Only the
passes cost tokens, so the rule above holds: ask first, and run them when the change alters what the model reads.
A change that alters only placement or the transcript is judged by the ledger and replays.

Reading it:

- **Passes disagree.** Two passes of the same code differ by a few points on most factors. Run 4 a side, and treat a
  difference marked "within the spread" as no result. A change ships on the scorecard when the overall goes up and no
  factor falls clear of the spread.
- **Recordings count once each.** A side's figure is the mean over recordings of the mean over that recording's passes.
  With fewer than three recordings the card describes those videos more than the cutting: add a case for every
  recording the editor supplies with its published video (`dataset.ts build … --published-media`, see `README.md`).
- **Too tight scores as low as too loose.** Dead air and cut count measure distance from the editor's cut on either
  side, so a pass that trims every short pause loses what a pass that trims none loses.
- **Past mistakes** is the ledger's pass rate on this checkout (`--ledger`), beside the card, not in the overall.
- Calls for the editor, minutes and tokens are printed under the card and not scored: fewer calls is not better when
  the call was the editor's to make.

## 6. Record

- After the change merges, run `ledger.ts check --record --label "<PR>"` on main, so the next thread compares against it.
- Mark the entry `fixed` with the PR, and update `history.md`: the cause, what worked, what didn't and what's left open.
- `ledger.ts board` shows the runs over time: the count of passing entries should only go up.
