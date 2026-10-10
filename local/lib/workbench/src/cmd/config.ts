import { loadConfig } from "../config";
export async function run(_: string[]) { console.log(JSON.stringify(loadConfig(), null, 2)); return 0; }
