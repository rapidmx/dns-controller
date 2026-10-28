///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { KubeClient } from "../kube/KubeClient.js";
import { managedLabels, type ManifestSettings } from "./manifests.js";

/** The objects at `path` (a namespaced collection) that this release's controller manages: what pruning and status reports read. */
export async function listManaged<T>(kube: Pick<KubeClient, "get">, path: string, settings: Pick<ManifestSettings, "release">): Promise<T[]> {
    const selector: string = Object.entries(managedLabels(settings))
        .map(([key, value]) => `${key}=${value}`)
        .join(",");
    const answer = await kube.get<{ items?: T[] }>(`${path}?${new URLSearchParams({ labelSelector: selector })}`);
    // An empty list may come without `items`.
    return answer.items ?? [];
}
