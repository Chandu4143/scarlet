import { z } from "zod/v3";
import type { CutConfidence } from "@scarlet/timeline";

/**
 * The editor's setting for how much Scarlet checks with them: which of the edits Scarlet isn't certain of are theirs
 * to look at. Scarlet says how sure it is of each (`CutConfidence`) and what could be wrong; the setting only picks
 * how far down that scale the editor is asked. It never grades an edit itself.
 */
export const CheckIn = z.enum(["less", "balanced", "more"]);
export type CheckIn = z.infer<typeof CheckIn>;

/** The grades each setting brings to the editor. `certain` never does: Scarlet named nothing to check. */
const BROUGHT: Record<CheckIn, readonly CutConfidence[]> = {
  less: ["low"],
  balanced: ["low", "medium"],
  more: ["low", "medium", "high"],
};

/** Whether an edit Scarlet graded this way is the editor's to check under their setting. */
export function reachesEditor(confidence: CutConfidence, checkIn: CheckIn): boolean {
  return BROUGHT[checkIn].includes(confidence);
}
