import { rebuild } from "../metrics/store";

const report = await rebuild();
console.log("[holo] materialized →", JSON.stringify(report, null, 2));
process.exit(0);
