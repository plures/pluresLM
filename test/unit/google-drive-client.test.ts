/**
 * Tests for GoogleDriveClient in src/google-drive-client.ts.
 *
 * All `gog` CLI invocations are mocked via vi.mock so no real CLI is required.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDriveClient } from "../../src/google-drive-client.js";
import type { GoogleDriveFile } from "../../src/google-drive-client.js";

// ---------------------------------------------------------------------------
// Mock child_process.execFile + util.promisify
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile } from "node:child_process";
const mockedExecFile = vi.mocked(execFile as unknown as (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_FILES: GoogleDriveFile[] = [
  {
    id: "abc123",
    name: "Project Spec",
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: "2026-01-10T12:00:00Z",
  },
  {
    id: "def456",
    name: "Budget.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    modifiedTime: "2026-01-11T09:30:00Z",
    size: 40960,
  },
];

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------

describe("GoogleDriveClient.listFiles", () => {
  let client: GoogleDriveClient;

  beforeEach(() => {
    client = new GoogleDriveClient();
    vi.resetAllMocks();
  });

  it("returns parsed file list from gog drive list --json", async () => {
    mockedExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify(SAMPLE_FILES),
      stderr: "",
    });

    const files = await client.listFiles();
    expect(files).toHaveLength(2);
    expect(files[0].id).toBe("abc123");
    expect(files[0].name).toBe("Project Spec");
    expect(files[1].size).toBe(40960);
  });

  it("calls gog with correct arguments", async () => {
    mockedExecFile.mockResolvedValueOnce({ stdout: "[]", stderr: "" });
    await client.listFiles();
    expect(mockedExecFile).toHaveBeenCalledWith("gog", ["drive", "list", "--json"]);
  });

  it("returns empty array when gog returns an empty list", async () => {
    mockedExecFile.mockResolvedValueOnce({ stdout: "[]", stderr: "" });
    const files = await client.listFiles();
    expect(files).toEqual([]);
  });

  it("throws on auth / CLI failure", async () => {
    mockedExecFile.mockRejectedValueOnce(new Error("not authenticated"));
    await expect(client.listFiles()).rejects.toThrow("gog drive list failed: not authenticated");
  });

  it("throws when gog returns non-JSON output", async () => {
    mockedExecFile.mockResolvedValueOnce({ stdout: "not json", stderr: "" });
    await expect(client.listFiles()).rejects.toThrow("gog drive list returned non-JSON output");
  });

  it("throws when gog returns a non-array JSON value", async () => {
    mockedExecFile.mockResolvedValueOnce({ stdout: '{"error":"oops"}', stderr: "" });
    await expect(client.listFiles()).rejects.toThrow("gog drive list returned unexpected JSON structure");
  });

  it("coerces missing fields to safe defaults", async () => {
    mockedExecFile.mockResolvedValueOnce({
      stdout: JSON.stringify([{ id: "x" }]),
      stderr: "",
    });
    const [file] = await client.listFiles();
    expect(file.name).toBe("");
    expect(file.mimeType).toBe("");
    expect(file.modifiedTime).toBe("");
    expect(file.size).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// exportDocument
// ---------------------------------------------------------------------------

describe("GoogleDriveClient.exportDocument", () => {
  let client: GoogleDriveClient;

  beforeEach(() => {
    client = new GoogleDriveClient();
    vi.resetAllMocks();
  });

  it("returns exported text from gog drive export", async () => {
    mockedExecFile.mockResolvedValueOnce({ stdout: "Hello, World!", stderr: "" });
    const text = await client.exportDocument("abc123");
    expect(text).toBe("Hello, World!");
  });

  it("calls gog with correct arguments", async () => {
    mockedExecFile.mockResolvedValueOnce({ stdout: "content", stderr: "" });
    await client.exportDocument("abc123");
    expect(mockedExecFile).toHaveBeenCalledWith("gog", [
      "drive", "export",
      "--id", "abc123",
      "--format", "text/plain",
    ]);
  });

  it("marks file as processed after successful export", async () => {
    mockedExecFile.mockResolvedValueOnce({ stdout: "text", stderr: "" });
    await client.exportDocument("abc123");
    expect(client.isProcessed("abc123")).toBe(true);
  });

  it("does not mark file as processed on export failure", async () => {
    mockedExecFile.mockRejectedValueOnce(new Error("quota exceeded"));
    await expect(client.exportDocument("abc123")).rejects.toThrow();
    expect(client.isProcessed("abc123")).toBe(false);
  });

  it("throws with file ID included in error message on failure", async () => {
    mockedExecFile.mockRejectedValueOnce(new Error("permission denied"));
    await expect(client.exportDocument("abc123")).rejects.toThrow(
      "gog drive export failed for file abc123: permission denied",
    );
  });
});

// ---------------------------------------------------------------------------
// downloadFile
// ---------------------------------------------------------------------------

describe("GoogleDriveClient.downloadFile", () => {
  let client: GoogleDriveClient;

  beforeEach(() => {
    client = new GoogleDriveClient();
    vi.resetAllMocks();
  });

  it("calls gog drive download with correct arguments", async () => {
    mockedExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await client.downloadFile("def456", "/tmp/Budget.xlsx");
    expect(mockedExecFile).toHaveBeenCalledWith("gog", [
      "drive", "download",
      "--id", "def456",
      "--output", "/tmp/Budget.xlsx",
    ]);
  });

  it("marks file as processed after successful download", async () => {
    mockedExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" });
    await client.downloadFile("def456", "/tmp/Budget.xlsx");
    expect(client.isProcessed("def456")).toBe(true);
  });

  it("does not mark file as processed on download failure", async () => {
    mockedExecFile.mockRejectedValueOnce(new Error("network timeout"));
    await expect(client.downloadFile("def456", "/tmp/Budget.xlsx")).rejects.toThrow();
    expect(client.isProcessed("def456")).toBe(false);
  });

  it("throws with file ID included in error message on failure", async () => {
    mockedExecFile.mockRejectedValueOnce(new Error("file not found"));
    await expect(client.downloadFile("def456", "/tmp/out")).rejects.toThrow(
      "gog drive download failed for file def456: file not found",
    );
  });
});

// ---------------------------------------------------------------------------
// Processed file tracking
// ---------------------------------------------------------------------------

describe("GoogleDriveClient processed file tracking", () => {
  let client: GoogleDriveClient;

  beforeEach(() => {
    client = new GoogleDriveClient();
    vi.resetAllMocks();
  });

  it("isProcessed returns false for unknown files", () => {
    expect(client.isProcessed("unknown")).toBe(false);
  });

  it("markProcessed registers a file without CLI call", () => {
    client.markProcessed("abc123");
    expect(client.isProcessed("abc123")).toBe(true);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("getProcessedIds returns all processed IDs", async () => {
    client.markProcessed("id1");
    client.markProcessed("id2");
    const ids = client.getProcessedIds();
    expect(ids.has("id1")).toBe(true);
    expect(ids.has("id2")).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("filterUnprocessed removes already-processed files", () => {
    client.markProcessed("abc123");
    const filtered = client.filterUnprocessed(SAMPLE_FILES);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("def456");
  });

  it("filterUnprocessed returns all files when none are processed", () => {
    expect(client.filterUnprocessed(SAMPLE_FILES)).toHaveLength(2);
  });

  it("filterUnprocessed returns empty array when all are processed", () => {
    SAMPLE_FILES.forEach((f) => client.markProcessed(f.id));
    expect(client.filterUnprocessed(SAMPLE_FILES)).toHaveLength(0);
  });
});
