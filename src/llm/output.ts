import { DateTime } from "luxon";
import { z } from "zod";

export type TurnOutput = z.output<typeof turnOutputSchema>;
export type CleanupOutput = z.output<typeof cleanupOutputSchema>;

/** Parses the model's final text into a value, or explains why it cannot. */
export type OutputParser<T> = (
  text: string,
) => { ok: true; value: T } | { ok: false; error: string };

const OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;

const nextAtSchema = z
  .string()
  .refine((text) => OFFSET_PATTERN.test(text), "next.at needs a UTC offset")
  .transform((text, ctx) => {
    const at = DateTime.fromISO(text, { setZone: true });
    if (!at.isValid) {
      ctx.addIssue({ code: "custom", message: `next.at is not ISO 8601: ${at.invalidReason}` });
      return z.NEVER;
    }
    return at;
  });

const turnOutputSchema = z.object({
  messages: z.array(z.string()),
  flow: z.enum(["continue", "end"]),
  next: z.object({
    at: nextAtSchema,
    type: z.string().min(1),
    memo: z.string().default(""),
  }),
});

const cleanupOutputSchema = z.object({ done: z.literal(true) });

export const parseTurnOutput: OutputParser<TurnOutput> = (text) =>
  parseJson(turnOutputSchema, text);
export const parseCleanupOutput: OutputParser<CleanupOutput> = (text) =>
  parseJson(cleanupOutputSchema, text);

function parseJson<T extends z.ZodType>(
  schema: T,
  text: string,
): { ok: true; value: z.output<T> } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not json: ${(error as Error).message}` };
  }
  const result = schema.safeParse(json);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}
