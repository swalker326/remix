import type { Router } from "@remix-run/router";
import { matchRoutes } from "@remix-run/router";
import * as React from "react";
import type { unstable_PatchRoutesOnMissFunction } from "react-router";

import type { AssetsManifest, FutureConfig } from "./entry";
import type { RouteModules } from "./routeModules";
import { createClientRoutes } from "./routes";

declare global {
  interface Navigator {
    connection?: { saveData: boolean };
  }
}

type FogOfWarInfo = {
  // Currently rendered links that may need prefetching
  nextPaths: Set<string>;
  // Paths we know the client can already match, so no need to perform client-side
  // matching or prefetching for them.  Just an optimization to avoid re-matching
  // on a larger and larger route tree over time
  knownGoodPaths: Set<string>;
  // Routes the server was unable to match - don't ask for them again
  known404Paths: Set<string>;
};

// 7.5k to come in under the ~8k limit for most browsers
// https://stackoverflow.com/a/417184
const URL_LIMIT = 7680;

let fogOfWar: FogOfWarInfo | null = null;

export function isFogOfWarEnabled(future: FutureConfig, isSpaMode: boolean) {
  return future.unstable_lazyRouteDiscovery === true && !isSpaMode;
}

export function getPartialManifest(manifest: AssetsManifest, router: Router) {
  // Start with our matches for this pathname
  let routeIds = new Set(router.state.matches.map((m) => m.route.id));

  let segments = router.state.location.pathname.split("/").filter(Boolean);
  let paths: string[] = ["/"];

  // We've already matched to the last segment
  segments.pop();

  // Traverse each path for our parents and match in case they have pathless/index
  // children we need to include in the initial manifest
  while (segments.length > 0) {
    paths.push(`/${segments.join("/")}`);
    segments.pop();
  }

  paths.forEach((path) => {
    let matches = matchRoutes(router.routes, path, router.basename);
    if (matches) {
      matches.forEach((m) => routeIds.add(m.route.id));
    }
  });

  let initialRoutes = [...routeIds].reduce(
    (acc, id) => Object.assign(acc, { [id]: manifest.routes[id] }),
    {}
  );

  return {
    ...manifest,
    routes: initialRoutes,
  };
}

export function initFogOfWar(
  manifest: AssetsManifest,
  routeModules: RouteModules,
  future: FutureConfig,
  isSpaMode: boolean,
  basename: string | undefined
): {
  enabled: boolean;
  patchRoutesOnMiss?: unstable_PatchRoutesOnMissFunction;
} {
  if (!isFogOfWarEnabled(future, isSpaMode)) {
    return { enabled: false };
  }

  fogOfWar = {
    nextPaths: new Set<string>(),
    knownGoodPaths: new Set<string>(),
    known404Paths: new Set<string>(),
  };

  return {
    enabled: true,
    patchRoutesOnMiss: async ({ path, patch }) => {
      if (
        fogOfWar!.known404Paths.has(path) ||
        fogOfWar!.knownGoodPaths.has(path)
      ) {
        return;
      }
      await fetchAndApplyManifestPatches(
        [path],
        fogOfWar!,
        manifest,
        routeModules,
        future,
        isSpaMode,
        basename,
        patch
      );
    },
  };
}

export function useFogOFWarDiscovery(
  router: Router,
  manifest: AssetsManifest,
  routeModules: RouteModules,
  future: FutureConfig,
  isSpaMode: boolean
) {
  React.useEffect(() => {
    // Don't prefetch if not enabled or if the user has `saveData` enabled
    if (
      !isFogOfWarEnabled(future, isSpaMode) ||
      navigator.connection?.saveData === true
    ) {
      return;
    }

    // Register a link href for patching
    function registerElement(el: Element) {
      let path =
        el.tagName === "FORM"
          ? el.getAttribute("action")
          : el.getAttribute("href");
      if (!path) {
        return;
      }
      let url = new URL(path, window.location.origin);
      let { knownGoodPaths, known404Paths, nextPaths } = fogOfWar!;
      if (knownGoodPaths.has(url.pathname) || known404Paths.has(url.pathname)) {
        return;
      }
      nextPaths.add(url.pathname);
    }

    // Fetch patches for all currently rendered links
    async function fetchPatches() {
      let lazyPaths = getFogOfWarPaths(fogOfWar!, router);
      if (lazyPaths.length === 0) {
        return;
      }

      try {
        await fetchAndApplyManifestPatches(
          lazyPaths,
          fogOfWar!,
          manifest,
          routeModules,
          future,
          isSpaMode,
          router.basename,
          router.patchRoutes
        );
      } catch (e) {
        console.error("Failed to fetch manifest patches", e);
      }
    }

    // Register and fetch patches for all initially-rendered links/forms
    document.body
      .querySelectorAll("a[data-discover], form[data-discover]")
      .forEach((el) => registerElement(el));

    fetchPatches();

    // Setup a MutationObserver to fetch all subsequently rendered links/forms
    let debouncedFetchPatches = debounce(fetchPatches, 100);

    function isElement(node: Node): node is Element {
      return node.nodeType === Node.ELEMENT_NODE;
    }

    let observer = new MutationObserver((records) => {
      let elements = new Set<Element>();
      records.forEach((r) => {
        [r.target, ...r.addedNodes].forEach((node) => {
          if (!isElement(node)) return;
          if (node.tagName === "A" && node.getAttribute("data-discover")) {
            elements.add(node);
          } else if (
            node.tagName === "FORM" &&
            node.getAttribute("data-discover")
          ) {
            elements.add(node);
          }
          if (node.tagName !== "A") {
            node
              .querySelectorAll("a[data-discover], form[data-discover]")
              .forEach((el) => elements.add(el));
          }
        });
      });
      elements.forEach((el) => registerElement(el));

      debouncedFetchPatches();
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-discover", "href", "action"],
    });

    return () => observer.disconnect();
  }, [future, isSpaMode, manifest, routeModules, router]);
}

function getFogOfWarPaths(fogOfWar: FogOfWarInfo, router: Router) {
  let { knownGoodPaths, known404Paths, nextPaths } = fogOfWar;
  return Array.from(nextPaths.keys()).filter((path) => {
    if (knownGoodPaths.has(path)) {
      nextPaths.delete(path);
      return false;
    }

    if (known404Paths.has(path)) {
      nextPaths.delete(path);
      return false;
    }

    return true;
  });
}

export async function fetchAndApplyManifestPatches(
  paths: string[],
  _fogOfWar: FogOfWarInfo,
  manifest: AssetsManifest,
  routeModules: RouteModules,
  future: FutureConfig,
  isSpaMode: boolean,
  basename: string | undefined,
  patchRoutes: Router["patchRoutes"]
): Promise<void> {
  let { nextPaths, knownGoodPaths, known404Paths } = _fogOfWar;
  let manifestPath = `${basename ?? "/"}/__manifest`.replace(/\/+/g, "/");
  let url = new URL(manifestPath, window.location.origin);
  url.searchParams.set("version", manifest.version);
  paths.forEach((path) => url.searchParams.append("p", path));

  // If the URL is nearing the ~8k limit on GET requests, skip this optimization
  // step and just let discovery happen on link click.  We also wipe out the
  // nextPaths Set here so we can start filling it with fresh links
  if (url.toString().length > URL_LIMIT) {
    nextPaths.clear();
    return;
  }

  let res = await fetch(url);

  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  } else if (res.status >= 400) {
    throw new Error(await res.text());
  }

  let data = (await res.json()) as {
    notFoundPaths: string[];
    patches: AssetsManifest["routes"];
  };

  // Capture this before we apply the patches to the manifest
  let knownRoutes = new Set(Object.keys(manifest.routes));

  // Patch routes we don't know about yet into the manifest
  let patches: AssetsManifest["routes"] = Object.values(data.patches).reduce(
    (acc, route) =>
      !knownRoutes.has(route.id)
        ? Object.assign(acc, { [route.id]: route })
        : acc,
    {}
  );
  Object.assign(manifest.routes, patches);

  // Track legit 404s so we don't try to fetch them again
  data.notFoundPaths.forEach((p) => known404Paths.add(p));

  // Track matched paths so we don't have to fetch them again
  paths.forEach((p) => knownGoodPaths.add(p));

  // Identify all parentIds for which we have new children to add and patch
  // in their new children
  let parentIds = new Set<string | undefined>();
  Object.values(patches).forEach((patch) => {
    if (!patch.parentId || !patches[patch.parentId]) {
      parentIds.add(patch.parentId);
    }
  });
  parentIds.forEach((parentId) =>
    patchRoutes(
      parentId || null,
      createClientRoutes(
        patches,
        routeModules,
        null,
        future,
        isSpaMode,
        parentId
      )
    )
  );
}

// Thanks Josh!
// https://www.joshwcomeau.com/snippets/javascript/debounce/
function debounce(callback: (...args: unknown[]) => unknown, wait: number) {
  let timeoutId: number | undefined;
  return (...args: unknown[]) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => callback(...args), wait);
  };
}
