import { describe, expect, it } from "vitest";
import {
  HOME_FEATURE_GROUPS,
  HOME_FEATURE_IDS,
  HOME_FEATURE_REGISTRY_V1,
  HOME_FEATURE_REGION_IDS,
  getHomeFeature,
  homeFeatureRegistryIssues,
  homeFeaturesForGroup,
  homeFeaturesForRegion,
} from "./home-feature-registry";

describe("HomeFeatureRegistryV1", () => {
  it("declares every feature id exactly once with complete copy", () => {
    expect(HOME_FEATURE_REGISTRY_V1).toHaveLength(HOME_FEATURE_IDS.length);
    expect(new Set(HOME_FEATURE_REGISTRY_V1.map((feature) => feature.id)).size).toBe(HOME_FEATURE_IDS.length);
    expect(homeFeatureRegistryIssues()).toEqual([]);
  });

  it("keeps every room feature in its region and every non-catalog feature in the directory", () => {
    const regionFeatureIds = HOME_FEATURE_REGION_IDS.flatMap((region) => homeFeaturesForRegion(region).map((feature) => feature.id));
    const expectedRegionIds = HOME_FEATURE_REGISTRY_V1.filter((feature) => feature.region !== "system").map((feature) => feature.id);
    expect(new Set(regionFeatureIds)).toEqual(new Set(expectedRegionIds));

    const catalogFeatureIds = HOME_FEATURE_GROUPS.flatMap((group) => homeFeaturesForGroup(group.id).map((feature) => feature.id));
    const expectedCatalogIds = HOME_FEATURE_REGISTRY_V1.filter((feature) => feature.catalogVisible).map((feature) => feature.id);
    expect(new Set(catalogFeatureIds)).toEqual(new Set(expectedCatalogIds));
    expect(catalogFeatureIds).not.toContain("catalog");
  });

  it("keeps every implemented surface executable and leaves write-only features pending", () => {
    expect(getHomeFeature("catalog").availability).toBe("native");
    expect(getHomeFeature("companion").availability).toBe("native");
    expect(HOME_FEATURE_REGISTRY_V1.filter((feature) => feature.availability === "native").map((feature) => feature.id)).toEqual([
      "continue",
      "today-review",
      "current-notebook",
      "all-notes",
      "sources",
      "learning-cards",
      "room-search",
      "global-search",
      "catalog",
      "current-target",
      "understanding-graph",
      "companion",
      "companion-diary",
      "companion-persona",
      "companion-memory",
      "memory-graph",
      "personal-center",
      "settings",
    ]);
    for (const feature of HOME_FEATURE_REGISTRY_V1.filter((candidate) => candidate.availability === "pending")) {
      expect(feature.pendingTitle).toBeTruthy();
      expect(feature.pendingDetail).toBeTruthy();
    }
  });
});
