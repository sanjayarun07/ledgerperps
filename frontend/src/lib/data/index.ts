import { INDEXER_URL } from "../config";
import { chainSource } from "./chain";
import { indexerSource } from "./indexer";
import type { DataSource } from "./types";

export const dataSource: DataSource = INDEXER_URL ? indexerSource : chainSource;
export * from "./types";
