import type { StrictRequest } from "msw";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  it as itBase,
  vi,
} from "vitest";

import { lookup } from "@uploadthing/mime-types";
import { generateUploadThingURL } from "@uploadthing/shared";

import { UPLOADTHING_VERSION } from "../src/internal/constants";
import type {
  ActionType,
  MPUResponse,
  PresignedBase,
  PSPResponse,
} from "../src/internal/types";

export const requestSpy = vi.fn();
export const middlewareMock = vi.fn();
export const uploadCompleteMock = vi.fn();
export const onErrorMock = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
});

export const createApiUrl = (slug: string, action?: ActionType) => {
  const url = new URL("http://localhost:3000");
  url.searchParams.set("slug", slug);
  if (action) url.searchParams.set("actionType", action);
  return url;
};

export const baseHeaders = {
  "x-uploadthing-version": UPLOADTHING_VERSION,
  "x-uploadthing-package": "vitest",
};

const mockPresigned = (file: {
  name: string;
  size: number;
  customId: string | null;
}): PSPResponse | MPUResponse => {
  const base: PresignedBase = {
    contentDisposition: "inline",
    customId: file.customId ?? null,
    fileName: file.name,
    fileType: lookup(file.name) as any,
    fileUrl: "https://utfs.io/f/abc-123.txt",
    key: "abc-123.txt",
    pollingJwt: "random-jwt",
    pollingUrl: generateUploadThingURL("/api/serverCallback"),
  };
  if (file.size > 5 * 1024 * 1024) {
    return {
      ...base,
      chunkCount: 2,
      chunkSize: file.size / 2,
      uploadId: "random-upload-id",
      urls: [
        "https://bucket.s3.amazonaws.com/abc-123.txt?partNumber=1&uploadId=random-upload-id",
        "https://bucket.s3.amazonaws.com/abc-123.txt?partNumber=2&uploadId=random-upload-id",
      ],
    };
  }
  return {
    ...base,
    url: "https://bucket.s3.amazonaws.com",
    fields: { key: "abc-123.txt" },
  };
};

const callRequestSpy = async (request: StrictRequest<any>) =>
  requestSpy(new URL(request.url).toString(), {
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: await (() => {
      if (request.method === "GET") return null;
      const ct = request.headers.get("content-type");
      const cloned = request.clone();
      if (ct?.includes("application/json")) return cloned.json();
      if (ct?.includes("multipart/form-data")) return cloned.formData();
      return cloned.blob();
    })(),
  });

export const msw = setupServer(
  /**
   * S3
   */
  http.post("https://bucket.s3.amazonaws.com", async ({ request }) => {
    await callRequestSpy(request);
    return new HttpResponse();
  }),
  http.put("https://bucket.s3.amazonaws.com/:key", async ({ request }) => {
    await callRequestSpy(request);
    return new HttpResponse(null, {
      status: 204,
      headers: { ETag: "abc123" },
    });
  }),
  /**
   * Static Assets
   */
  http.get("https://cdn.foo.com/:fileKey", async ({ request }) => {
    await callRequestSpy(request);
    return HttpResponse.text("Lorem ipsum doler sit amet");
  }),
  http.get("https://utfs.io/f/:key", async ({ request }) => {
    await callRequestSpy(request);
    return HttpResponse.text("Lorem ipsum doler sit amet");
  }),
);
beforeAll(() => msw.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => msw.close());

export interface MockDbInterface {
  files: any[];
  insertFile: (file: any) => void;
  getFileByKey: (key: string) => any;
}

/**
 * Prepend MSW listeners to mock the UploadThing API
 * Provide the `db` instance to store data within the test
 */
export const useDb = (db: MockDbInterface) =>
  msw.use(
    http.post<never, { files: any[] } & Record<string, string>>(
      "https://uploadthing.com/api/prepareUpload",
      async ({ request }) => {
        await callRequestSpy(request);
        const body = await request.json();

        const presigneds = body.files.map((file) => {
          const presigned = mockPresigned(file);
          db.insertFile({
            ...file,
            key: presigned.key,
            callbackUrl: body.callbackUrl,
            callbackSlug: body.callbackSlug,
          });
          return presigned;
        });
        return HttpResponse.json(presigneds);
      },
    ),
    http.post<never, { files: any[] }>(
      "https://uploadthing.com/api/uploadFiles",
      async ({ request }) => {
        await callRequestSpy(request);
        const body = await request.json();

        const presigneds = body?.files.map((file) => {
          const presigned = mockPresigned(file);
          db.insertFile({
            ...file,
            key: presigned.key,
          });
          return presigned;
        });
        return HttpResponse.json({ data: presigneds });
      },
    ),
    http.post(
      "https://uploadthing.com/api/completeMultipart",
      async ({ request }) => {
        await callRequestSpy(request);
        return HttpResponse.json({ success: true });
      },
    ),
    http.post(
      "https://uploadthing.com/api/failureCallback",
      async ({ request }) => {
        await callRequestSpy(request);
        return HttpResponse.json({ success: true });
      },
    ),
    http.get<{ key: string }>(
      "https://uploadthing.com/api/pollUpload/:key",
      async ({ request, params }) => {
        await callRequestSpy(request);
        return HttpResponse.json({
          status: "done",
          fileData: db.getFileByKey(params.key),
        });
      },
    ),
    http.post(
      "https://uploadthing.com/api/requestFileAccess",
      async ({ request }) => {
        await callRequestSpy(request);
        return HttpResponse.json({
          url: "https://utfs.io/f/someFileKey?x-some-amz=query-param",
        });
      },
    ),
    http.post(
      "https://uploadthing.com/api/serverCallback",
      async ({ request }) => {
        await callRequestSpy(request);
        return HttpResponse.json({ success: true });
      },
    ),
    http.get(
      "https://uploadthing.com/api/serverCallback",
      async ({ request }) => {
        await callRequestSpy(request);
        return HttpResponse.json({ success: true });
      },
    ),
  );

export const useBadS3 = () =>
  msw.use(
    http.post("https://bucket.s3.amazonaws.com", async ({ request }) => {
      await callRequestSpy(request);
      return new HttpResponse(null, { status: 403 });
    }),
    http.put("https://bucket.s3.amazonaws.com/:key", async ({ request }) => {
      await callRequestSpy(request);
      return new HttpResponse(null, { status: 204 });
    }),
  );

/**
 * Extend the base `it` function to provide a `db` instance to our tests
 * and extend the MSW handlers to mock the UploadThing API
 *
 * NOTE:: Tests **must** destruct the `db` instance from the test context for it to be used
 * @example it("should do something", ({ db }) => { ... })
 */
export const it = itBase.extend<{ db: MockDbInterface }>({
  // eslint-disable-next-line no-empty-pattern
  db: async ({}, use) => {
    const files: any[] = [];
    const db: MockDbInterface = {
      files,
      insertFile: (file) => files.push(file),
      getFileByKey: (key) => files.find((f) => f.key === key),
    };
    useDb(db); // prepend msw listeners to use db instance
    await use(db); // provide test context
    files.length = 0; // clear files after each test
  },
});
