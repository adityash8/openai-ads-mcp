import fs from "node:fs/promises";
import path from "node:path";
import { ApprovalArtifactSchema, type ApprovalArtifact } from "./schemas";

export async function loadApprovalArtifact(
  approvalDir: string,
  approvalId: string
): Promise<ApprovalArtifact> {
  if (approvalId.includes("/") || approvalId.includes("\\") || approvalId.includes("..")) {
    throw new Error("approval_id must be a simple file id, not a path.");
  }

  const filePath = path.join(approvalDir, `${approvalId}.json`);
  const raw = await fs.readFile(filePath, "utf8");
  return ApprovalArtifactSchema.parse(JSON.parse(raw));
}

export async function writeDraftApproval(
  approvalDir: string,
  approval: ApprovalArtifact
): Promise<string> {
  await fs.mkdir(approvalDir, { recursive: true });
  const filePath = path.join(approvalDir, `${approval.id}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(approval, null, 2)}\n`, {
    flag: "wx",
  });
  return filePath;
}
