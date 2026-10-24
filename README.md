# GFL Skill Analyzer

A static web page that explains how the skills of any Girls' Frontline T-Doll, enemy (`enemy_character_type`) or Coalition unit (`sangvis`) work, read straight from the game's battle tables. It loads the tables from the [GFLData](https://github.com/randomqwerty/GFLData) repository, so new units appear as soon as that repository is updated.

## Files

| File | What it is |
|---|---|
| `index.html`, `app.js` | The page: doll list, filters, skill-level sliders, data source |
| `analyzer.js` | The analysis. It has no dependencies and runs in the browser and in Node |
| `checks.js` | The bug checks: skill levels, description vs data, buff values, stacking, targeting, triggers, skill order, formulas, missing data |
| `hidden.js` | Hidden effects: what a kit does that none of its texts states |
| `field.js` | Battlefield geometry (slot and link positions, area hit tests, target picking) and the SVG drawing of where an object lands |
| `plain.js` | The "In short" summary of each skill, built from the data with fixed phrases |
| `render.js` | Turns an analysis into HTML; its `PAGE_CSS` holds the shared styles |
| `glossary-en.json` | English labels for the developers' Chinese buff and skill names |
| `build-report.mjs` | Runs every check on every unit and writes the findings as one Markdown file (Node 18+) |

## Hosting on GitHub Pages

1. Copy these files into a repository, either at the root or in a `docs/` folder.
2. In the repository settings, open **Pages** and choose **Deploy from a branch**. Pick that branch and folder.
3. Open `https://<user>.github.io/<repo>/`. Any unit can be linked directly: `#id=<doll id>`, `#enemy=<id>` or `#sangvis=<id>`. Optional parameters:
   - `&s1=` and `&s2=` set the skill levels, and `&s3=` and `&sa=` the Coalition Skill 3 and advance skill levels;
   - `&region=` sets the server (`en`, `ch`, `tw`, `kr`, `jp`);
   - `&repo=` sets a different data repository.

The page asks GitHub for the latest GFLData commit. It then downloads the tables (about 75 MB) from that exact commit and keeps them in the browser cache. A new upstream commit is picked up on the next visit, and **Reload data** clears the cache.

The page has to be served over http(s). Opening `index.html` as a local file blocks the module scripts. To try it locally:

```bash
python -m http.server 8765 --directory tools/skill-analyzer
```

## Finding bugs

Each unit's page starts with **Quirks found**, grouped by category, then **Hidden effects**. **Bug scan** in the sidebar runs every check on every doll, enemy or Coalition unit (up to half a minute per kind) and lists the results with unit, severity and category filters. Link to it with `#scan=gun`, `#scan=enemy`, `#scan=sangvis` or `#scan=all`.

Each skill also gets an **In short** line: when it fires, whom it targets and what each effect does, built from the data with fixed phrases.

Under each skill, **Show on the battlefield** draws where an area effect lands in a sample layout and which dummy links it reaches. Slots are numbered like a numpad (1–3 bottom row, 3/6/9 front column) and the green lines are GFLMaps' range lines. You can move the user and the target, or enter an **enemy team id** to place a real enemy composition. The page then downloads `enemy_in_team.json` (about 34 MB, once) and picks the target with the skill's own target rule. The rule sorts by distance, left-right or front-back distance, or HP (enemy HP is scaled to the row's level with `enemy_standard_attribute`, as GFLMaps does). Ties go to the enemy listed first in `enemy_in_team`, which matches what has been seen in battle. Range limits and sorts by other stats are not applied; the page says so when a rule uses them.

The same list can be written to a file:

```bash
node tools/skill-analyzer/build-report.mjs --data data --out doc/skill-analysis/findings-all-units.md
```

Options:

- `--data` takes a local folder with the GFLData layout (`stc/*.json`, `text/table/*.json`), or a URL; the default is GFLData on GitHub.
- `--kinds` picks the unit kinds (default `gun,enemy,sangvis`).
- `--level1` and `--level2` set the skill levels (default 10).
- `--all` also lists notes.

## When the game adds new mechanics

- **New developer labels** appear in Chinese until they are added to `glossary-en.json`. The key is the Chinese label without `[*]`; the value is the English label.
- **New buff types** show as "type N". Add them to `BUFF_TYPE_NAME` in `analyzer.js`, and to `PCT_STAT`, `FLAT_STAT` or `BUFF_COL` if they change a stat.
- **Engine rules** are commented in `analyzer.js` with the client method they were read from. Check them again if a game update changes the battle code.
