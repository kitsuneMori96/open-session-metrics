import { rebuild } from "../metrics/store";

const full = process.argv.includes("--full");
const report = await rebuild({ full });
console.log("[holo] materialized →", JSON.stringify(report, null, 2));
process.exit(0);
