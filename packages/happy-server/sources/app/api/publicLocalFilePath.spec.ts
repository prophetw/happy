import { describe, expect, it } from "vitest";
import { publicLocalFilePath } from "./publicLocalFilePath";

describe("public local files", () => {
  it("does not bypass avatar authentication through the static files route", () => {
    expect(publicLocalFilePath("/data/files", "sessions/s1/avatar/a.enc")).toBeNull();
    expect(publicLocalFilePath("/data/files", "public/../sessions/s1/avatar/a.enc")).toBeNull();
    expect(publicLocalFilePath("/data/files", "../private")).toBeNull();
    expect(publicLocalFilePath("/data/files", "public/avatar.webp")).toBe(
      "/data/files/public/avatar.webp",
    );
  });

  it('does not expose private attachments or project avatars through public files', () => {
    expect(publicLocalFilePath('/data/files', 'sessions/s1/attachments/a.enc')).toBeNull();
    expect(publicLocalFilePath('/data/files', 'public/../sessions/s1/attachments/a.enc')).toBeNull();
    expect(publicLocalFilePath('/data/files', 'projects/p1/avatar/a.enc')).toBeNull();
    expect(publicLocalFilePath('/data/files', 'public/avatar.webp')).toBe('/data/files/public/avatar.webp');
  });
});
