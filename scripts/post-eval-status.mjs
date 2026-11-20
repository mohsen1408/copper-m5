// Module 5 (CI only): shows the golden-set eval scores as a check on the pull
// request, like "Multi 9/10 (90%) · Single 8/10 (80%)", linking to the full
// table in the run's summary. Reads evals/results/latest.json (npm run eval).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const { GITHUB_REPOSITORY, SHA, RUN_URL } = process.env;
const file = "evals/results/latest.json";

let state = "error";
let description = "The eval didn't finish. Open the run for details.";
if (existsSync(file)) {
  const { summaries } = JSON.parse(readFileSync(file, "utf8"));
  const minPassRate = Number(process.env.EVAL_MIN_PASS_RATE ?? 0.8);
  const name = { multi: "Multi", single: "Single" };
  description = summaries
    .map(
      (s) =>
        `${name[s.architecture]} ${s.passed}/${s.total} (${Math.round(s.passRate * 100)}%), ${s.avgLatencySeconds.toFixed(1)}s, $${s.avgCostUsd.toFixed(4)}`,
    )
    .join(" · ");
  const multi = summaries.find((s) => s.architecture === "multi");
  state = multi && multi.passRate >= minPassRate ? "success" : "failure";
}

console.log(`${state}: ${description}`);
execFileSync(
  "gh",
  [
    "api",
    `repos/${GITHUB_REPOSITORY}/statuses/${SHA}`,
    "-f",
    `state=${state}`,
    "-f",
    "context=Eval scores (AI judge)",
    "-f",
    // GitHub shows at most 140 characters.
    `description=${description.slice(0, 140)}`,
    "-f",
    `target_url=${RUN_URL}`,
  ],
  { stdio: "inherit" },
);
