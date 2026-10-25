import type { ActivityStore, DetectedLink, LinksStore } from '@fb/core';
import { detectLinks, type LinkProject } from './detect.ts';

export type LinkStageDeps = {
  links: Pick<LinksStore, 'replaceDetected'>;
  /** The selected projects with their folders and remotes. */
  projects: () => Promise<LinkProject[]>;
  detect?: (projects: LinkProject[]) => Promise<DetectedLink[]>;
  activity?: Pick<ActivityStore, 'record'>;
};

/** One detection round over the selected projects: suggestions only; you confirm a link before agents use it. */
export async function runLinkDetection(d: LinkStageDeps): Promise<{ found: number; fresh: number }> {
  const projects = await d.projects();
  if (projects.length < 2) return { found: 0, fresh: 0 };
  const found = await (d.detect ?? detectLinks)(projects);
  const fresh = await d.links.replaceDetected(projects.map((p) => p.key), found);
  if (fresh) {
    const names = found.slice(0, 5).map((l) => `${l.a} ↔ ${l.b}`).join(', ');
    await d.activity?.record({
      kind: 'links_suggested', actor: 'deterministic', projectKey: null,
      subject: `${fresh} new link suggestion${fresh === 1 ? '' : 's'}: ${names}`,
      why: 'evidence in the projects (manifests, repository or name mentions) says they belong together; confirm a link on the Projects page before agents use it',
      details: { links: found.map((l) => ({ a: l.a, b: l.b, relation: l.relation, score: l.score, evidence: l.evidence })) },
      targets: [],
    });
  }
  return { found: found.length, fresh };
}
