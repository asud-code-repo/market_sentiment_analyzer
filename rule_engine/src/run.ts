import { classify } from "./classify.js";

classify().catch((err) => {
  console.error("Rule engine run failed:", err);
  process.exit(1);
});
