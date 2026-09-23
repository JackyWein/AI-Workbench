import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentKind,
  type MessageAttachment,
} from "@ai-workbench/shared";

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

/**
 * Checks each file the person attached and describes it from the disk, not
 * from what the window said about it: it must be a regular file, absolute,
 * and no larger than a message carries.
 */
export async function inspectAttachments(
  attachments: readonly Pick<MessageAttachment, "path">[],
): Promise<MessageAttachment[]> {
  const inspected: MessageAttachment[] = [];
  for (const { path } of attachments) {
    if (!isAbsolute(path)) {
      throw new AttachmentError(`"${path}" is not a full path to a file.`);
    }
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      throw new AttachmentError(`"${basename(path)}" is no longer there.`);
    }
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `"${basename(path)}" is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      );
    }
    const name = basename(path);
    inspected.push({ path, name, kind: attachmentKind(name), size: info.size });
  }
  return inspected;
}

/**
 * Copies attached files into the session's own folder, so the conversation
 * keeps them when the originals move, and a tool is only ever let into that
 * folder — never the one the person picked them from.
 */
export async function keepAttachments(
  attachments: readonly MessageAttachment[],
  folder: string,
): Promise<MessageAttachment[]> {
  await mkdir(folder, { recursive: true });
  const kept: MessageAttachment[] = [];
  const used = new Set<string>();
  for (const attachment of attachments) {
    const name = uniqueName(attachment.name, used);
    const target = join(folder, name);
    await copyFile(attachment.path, target);
    kept.push({ ...attachment, path: target });
  }
  return kept;
}

/** Removes a session's kept files; nothing to remove is not an error. */
export async function forgetAttachments(folder: string): Promise<void> {
  await rm(folder, { recursive: true, force: true });
}

/** Two files of the same name in one message keep both. */
function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let count = 2; used.has(candidate.toLowerCase()); count += 1) {
    candidate = `${stem} (${count})${extension}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}
