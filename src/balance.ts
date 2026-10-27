import { z } from "zod";
import type { StartupConfig } from "./config.ts";

/** Returns the account balance, or `undefined` when it cannot be read. */
export type BalanceReader = () => Promise<number | undefined>;

const balanceSchema = z.object({
  balance_infos: z.array(z.object({ currency: z.string(), total_balance: z.string() })).min(1),
});

/**
 * Reads the DeepSeek balance from `GET /user/balance` on the API host. Uses the first currency listed.
 * A failed request reads as `undefined`, so an unreachable balance API never stops LLM calls.
 */
export function createDeepSeekBalanceReader(
  config: Pick<StartupConfig, "llmBaseUrl" | "llmApiKey">,
  fetchFn: typeof fetch = fetch,
): BalanceReader {
  const url = new URL("/user/balance", config.llmBaseUrl);
  return async () => {
    try {
      const response = await fetchFn(url, {
        headers: { Authorization: `Bearer ${config.llmApiKey}`, Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = balanceSchema.parse(await response.json());
      const balance = Number(body.balance_infos[0]?.total_balance);
      if (Number.isNaN(balance)) throw new Error("total_balance is not a number");
      return balance;
    } catch (error) {
      console.error(`balance check failed: ${(error as Error).message}`);
      return undefined;
    }
  };
}
