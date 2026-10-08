import { describe, expect, it } from "vitest";
import {
  configurationDetail,
  configurationSummary,
  pickAutomaticRoute,
  routingOf,
  type RouteOption,
} from "../../components/account/links";

const route = (id: string, privacy_class = "fast"): RouteOption => ({ id, region: id, privacy_class, display_name: id });

describe("configurationSummary", () => {
  it("describes one-server automatic links the way the design does", () => {
    expect(configurationSummary({ locationMode: "auto", privacyClass: "fast" })).toBe("1 server · Automatic");
  });

  it("describes two-server manual links", () => {
    expect(configurationSummary({ locationMode: "manual", privacyClass: "privacy_plus" })).toBe("2 servers · Manual");
  });

  it("treats an unknown routing class as one server", () => {
    expect(configurationSummary({ locationMode: "manual", privacyClass: null })).toBe("1 server · Manual");
  });
});

describe("configurationDetail", () => {
  it("says an automatic location was picked for the user, and which", () => {
    expect(configurationDetail({ locationMode: "auto", routeLabel: "Germany · Frankfurt" })).toBe(
      "Location selected automatically: Germany · Frankfurt"
    );
  });

  it("shows a chosen location as is", () => {
    expect(configurationDetail({ locationMode: "manual", routeLabel: "Netherlands" })).toBe("Netherlands");
  });
});

describe("routingOf", () => {
  it("maps the backend privacy class to the number of servers", () => {
    expect(routingOf({ privacy_class: "fast" })).toBe("one");
    expect(routingOf({ privacy_class: "privacy_plus" })).toBe("two");
    expect(routingOf(undefined)).toBe("one");
  });
});

describe("pickAutomaticRoute", () => {
  it("returns null when there is nothing to pick", () => {
    expect(pickAutomaticRoute([])).toBeNull();
  });

  it("always returns one of the offered routes and uses more than one over many picks", () => {
    const routes = [route("a"), route("b"), route("c")];
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const picked = pickAutomaticRoute(routes);
      expect(routes).toContain(picked);
      seen.add(picked!.id);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
