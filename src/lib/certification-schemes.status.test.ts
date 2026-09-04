import { describe, test, expect } from "vitest";
import type { CertificationSchemeItem } from "@/lib/certification-schemes";

/**
 * The Standard Passport derives its regulatory status from a possibly-null
 * certification-scheme record. This pins the three-state logic that page
 * uses, because the two-state version rendered "Voluntary Standard
 * Reference" whenever the scheme was simply absent — presenting missing
 * data as a positive regulatory claim, which for a compliance product could
 * lead a manufacturer to skip mandatory certification.
 */
function regulatoryStatus(scheme: CertificationSchemeItem | null) {
  const isMandatory = scheme?.mandatoryQco === true;
  const isVoluntary = scheme != null && scheme.mandatoryQco !== true;
  return {
    status: isMandatory ? "Compulsory / QCO" : isVoluntary ? "Voluntary Reference" : "Not established",
    certification: scheme?.scheme ?? "Not established",
  };
}

const scheme = (over: Partial<CertificationSchemeItem> = {}): CertificationSchemeItem =>
  ({ standardNumber: "IS 1:2020", title: "t", mandatoryQco: false, scheme: "Scheme-I (ISI)", ...over }) as CertificationSchemeItem;

describe("Standard Passport regulatory status", () => {
  test("a mandatory QCO record reads as compulsory", () => {
    expect(regulatoryStatus(scheme({ mandatoryQco: true })).status).toBe("Compulsory / QCO");
  });

  test("a record that is explicitly not a QCO reads as voluntary", () => {
    expect(regulatoryStatus(scheme({ mandatoryQco: false })).status).toBe("Voluntary Reference");
  });

  test("no record at all is 'Not established' — never 'Voluntary'", () => {
    const result = regulatoryStatus(null);
    expect(result.status).toBe("Not established");
    // The regression: absence of data was rendered as a claim of voluntariness.
    expect(result.status).not.toMatch(/voluntary/i);
  });

  test("no record never defaults to a named certification scheme", () => {
    // The regression: this rendered "Scheme-I (ISI)" for any standard with
    // no scheme record, asserting a certification route with no evidence.
    expect(regulatoryStatus(null).certification).toBe("Not established");
    expect(regulatoryStatus(null).certification).not.toMatch(/Scheme-[IVX]/);
  });

  test("a real scheme name is shown when the record has one", () => {
    expect(regulatoryStatus(scheme({ scheme: "Scheme-II (CRS)" })).certification).toBe("Scheme-II (CRS)");
  });
});
