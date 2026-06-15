import { assertIsoDate } from "./schema.js";

export interface CompassHealthClientOptions {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly fetch: typeof fetch;
}

export interface CompassHealthDailyContext {
  readonly sourceUrl: string;
  readonly meals?: unknown;
  readonly unavailableReason?: string;
}

export type CompassHealthDailyContextReader = (date: string) => Promise<CompassHealthDailyContext>;

export function createCompassHealthClient(options: CompassHealthClientOptions): {
  readonly readDailyContext: CompassHealthDailyContextReader;
} {
  const baseUrl = parseCompassBaseUrl(options.baseUrl);

  return {
    readDailyContext: async (date: string): Promise<CompassHealthDailyContext> => {
      const isoDate = assertIsoDate(date, "date");
      const sourceUrl = buildDailyContextUrl(baseUrl, isoDate);

      try {
        const response = await options.fetch(sourceUrl, {
          method: "GET",
          ...(options.bearerToken === undefined
            ? {}
            : {
                headers: {
                  Authorization: `Bearer ${options.bearerToken}`
                }
              })
        });

        if (!response.ok) {
          return {
            sourceUrl,
            unavailableReason: `compass-health returned HTTP ${response.status}`
          };
        }

        try {
          return {
            sourceUrl,
            meals: await response.json()
          };
        } catch {
          return {
            sourceUrl,
            unavailableReason: "compass-health response was not valid JSON"
          };
        }
      } catch {
        return {
          sourceUrl,
          unavailableReason: "compass-health request failed"
        };
      }
    }
  };
}

function parseCompassBaseUrl(value: string): URL {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) {
    throw new Error("baseUrl must be an HTTP(S) URL without credentials");
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("baseUrl must be an HTTP(S) URL without credentials");
  }

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("baseUrl must be an HTTP(S) URL without credentials");
  }

  parsed.hash = "";
  parsed.search = "";
  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed;
}

function buildDailyContextUrl(baseUrl: URL, date: string): string {
  const url = new URL("api/meal-plan/daily-context", baseUrl);
  url.searchParams.set("date", date);
  return url.toString();
}
