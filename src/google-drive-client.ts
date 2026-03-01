/**
 * Google Drive Client
 *
 * Integrates with Google Drive via the `gog` CLI to list files, export
 * Google Docs as plain text, and download other file types for processing.
 * A simple in-memory Set tracks processed file IDs to avoid re-processing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: number;
}

export class GoogleDriveClient {
  /** File IDs that have already been processed in this session. */
  private readonly processed = new Set<string>();

  /**
   * List all files in Google Drive via `gog drive list --json`.
   * Throws if `gog` is not authenticated or unavailable.
   */
  async listFiles(): Promise<GoogleDriveFile[]> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("gog", ["drive", "list", "--json"]));
    } catch (err) {
      throw new Error(`gog drive list failed: ${(err as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("gog drive list returned non-JSON output");
    }

    if (!Array.isArray(parsed)) {
      throw new Error("gog drive list returned unexpected JSON structure");
    }

    return (parsed as Record<string, unknown>[]).map((item) => ({
      id: String(item["id"] ?? ""),
      name: String(item["name"] ?? ""),
      mimeType: String(item["mimeType"] ?? ""),
      modifiedTime: String(item["modifiedTime"] ?? ""),
      size: item["size"] !== undefined ? Number(item["size"]) : undefined,
    }));
  }

  /**
   * Export a Google Docs document as plain text via `gog drive export`.
   * Returns the exported text content.
   * Marks the file as processed on success.
   */
  async exportDocument(fileId: string): Promise<string> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("gog", [
        "drive",
        "export",
        "--id",
        fileId,
        "--format",
        "text/plain",
      ]));
    } catch (err) {
      throw new Error(
        `gog drive export failed for file ${fileId}: ${(err as Error).message}`,
      );
    }

    this.processed.add(fileId);
    return stdout;
  }

  /**
   * Download a file from Google Drive to a local path via `gog drive download`.
   * Marks the file as processed on success.
   */
  async downloadFile(fileId: string, outputPath: string): Promise<void> {
    try {
      await execFileAsync("gog", [
        "drive",
        "download",
        "--id",
        fileId,
        "--output",
        outputPath,
      ]);
    } catch (err) {
      throw new Error(
        `gog drive download failed for file ${fileId}: ${(err as Error).message}`,
      );
    }

    this.processed.add(fileId);
  }

  /**
   * Returns true if the given file ID has already been processed this session.
   */
  isProcessed(fileId: string): boolean {
    return this.processed.has(fileId);
  }

  /**
   * Mark a file as processed without exporting/downloading it.
   * Useful when a file was processed by an external mechanism.
   */
  markProcessed(fileId: string): void {
    this.processed.add(fileId);
  }

  /**
   * Returns the set of all processed file IDs in this session.
   */
  getProcessedIds(): ReadonlySet<string> {
    return this.processed;
  }

  /**
   * Filter a list of Drive files to only those that have not been processed.
   */
  filterUnprocessed(files: GoogleDriveFile[]): GoogleDriveFile[] {
    return files.filter((f) => !this.processed.has(f.id));
  }
}
