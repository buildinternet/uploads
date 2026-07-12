type Gallery = {
  id: string;
  workspace: string;
  title: string;
  description: string | null;
  visibility: "public";
  cover_item_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type Item = {
  id: string;
  gallery_id: string;
  object_key: string;
  position: number;
  caption: string | null;
  alt_text: string | null;
  created_at: string;
};

type Reference = {
  id: string;
  gallery_id: string;
  provider: string;
  resource_type: string;
  normalized_key: string;
  locator_json: string;
  canonical_url: string | null;
  created_at: string;
  updated_at: string;
};

function query(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Small D1 double for the hosted MCP gallery workflow. It deliberately
 * recognizes only exercised SQL so a persistence change expands the fixture
 * instead of silently weakening the test.
 */
export class GalleryFakeD1 {
  readonly galleries: Gallery[] = [];
  readonly items: Item[] = [];
  readonly references: Reference[] = [];

  prepare(sql: string) {
    return new GalleryFakeStatement(this, query(sql));
  }

  async batch(statements: GalleryFakeStatement[]) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class GalleryFakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: GalleryFakeD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM auth_tokens")) return null;
    if (this.sql.includes("FROM galleries WHERE id = ? AND workspace = ?")) {
      const [id, workspace] = this.values as [string, string];
      return (this.gallery(id, workspace) ?? null) as T | null;
    }
    throw new Error("unsupported D1 first query: " + this.sql);
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.sql.includes("FROM gallery_items i JOIN galleries g")) {
      const [galleryId, workspace] = this.values as [string, string];
      return this.result(
        this.database.items
          .filter(
            (item) => item.gallery_id === galleryId && this.gallery(item.gallery_id, workspace),
          )
          .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)) as T[],
      );
    }
    if (this.sql.includes("FROM gallery_external_references r JOIN galleries g")) {
      const [galleryId, workspace] = this.values as [string, string];
      return this.result(
        this.database.references
          .filter(
            (reference) => reference.gallery_id === galleryId && this.gallery(galleryId, workspace),
          )
          .sort(
            (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
          ) as T[],
      );
    }
    if (this.sql.includes("FROM galleries g JOIN gallery_external_references r")) {
      const [normalizedKey, workspace, , , , , limit] = this.values as [
        string,
        string,
        unknown,
        unknown,
        unknown,
        unknown,
        number,
      ];
      const galleries = this.database.galleries
        .filter(
          (gallery) =>
            gallery.workspace === workspace &&
            gallery.deleted_at === null &&
            this.database.references.some(
              (reference) =>
                reference.gallery_id === gallery.id && reference.normalized_key === normalizedKey,
            ),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .slice(0, limit);
      return this.result(galleries as T[]);
    }
    throw new Error("unsupported D1 all query: " + this.sql);
  }

  async run(): Promise<D1Result> {
    if (this.sql.startsWith("INSERT INTO galleries")) return this.createGallery();
    if (this.sql.startsWith("INSERT INTO gallery_items")) return this.insertItem();
    if (this.sql.startsWith("INSERT INTO gallery_external_references"))
      return this.insertReference();
    if (this.sql.startsWith("UPDATE galleries SET version = version + 1"))
      return this.bumpVersion();
    throw new Error("unsupported D1 run query: " + this.sql);
  }

  private createGallery(): D1Result {
    const [id, workspace, title, description, createdAt, updatedAt, countWorkspace, limit] = this
      .values as [string, string, string, string | null, string, string, string, number];
    const changes =
      this.database.galleries.filter(
        (gallery) => gallery.workspace === countWorkspace && gallery.deleted_at === null,
      ).length < limit
        ? 1
        : 0;
    if (changes) {
      this.database.galleries.push({
        id,
        workspace,
        title,
        description,
        visibility: "public",
        cover_item_id: null,
        version: 1,
        created_at: createdAt,
        updated_at: updatedAt,
        deleted_at: null,
      });
    }
    return this.mutation(changes);
  }

  private insertItem(): D1Result {
    const [
      id,
      objectKey,
      caption,
      altText,
      createdAt,
      galleryId,
      workspace,
      expectedVersion,
      duplicateKey,
      limit,
    ] = this.values as [
      string,
      string,
      string | null,
      string | null,
      string,
      string,
      string,
      number,
      string,
      number,
    ];
    const gallery = this.gallery(galleryId, workspace);
    const items = this.database.items.filter((item) => item.gallery_id === galleryId);
    const changes =
      gallery &&
      gallery.version === expectedVersion &&
      !items.some((item) => item.object_key === duplicateKey) &&
      items.length < limit
        ? 1
        : 0;
    if (changes) {
      this.database.items.push({
        id,
        gallery_id: galleryId,
        object_key: objectKey,
        position: (items.reduce((max, item) => Math.max(max, item.position), 0) || 0) + 1000,
        caption,
        alt_text: altText,
        created_at: createdAt,
      });
    }
    return this.mutation(changes);
  }

  private insertReference(): D1Result {
    const [
      id,
      provider,
      resourceType,
      normalizedKey,
      locatorJson,
      canonicalUrl,
      createdAt,
      updatedAt,
      galleryId,
      workspace,
      expectedVersion,
      duplicateKey,
      limit,
    ] = this.values as [
      string,
      string,
      string,
      string,
      string,
      string | null,
      string,
      string,
      string,
      string,
      number,
      string,
      number,
    ];
    const gallery = this.gallery(galleryId, workspace);
    const references = this.database.references.filter(
      (reference) => reference.gallery_id === galleryId,
    );
    const changes =
      gallery &&
      gallery.version === expectedVersion &&
      !references.some((reference) => reference.normalized_key === duplicateKey) &&
      references.length < limit
        ? 1
        : 0;
    if (changes) {
      this.database.references.push({
        id,
        gallery_id: galleryId,
        provider,
        resource_type: resourceType,
        normalized_key: normalizedKey,
        locator_json: locatorJson,
        canonical_url: canonicalUrl,
        created_at: createdAt,
        updated_at: updatedAt,
      });
    }
    return this.mutation(changes);
  }

  private bumpVersion(): D1Result {
    const [updatedAt, galleryId, workspace, expectedVersion, childId] = this.values as [
      string,
      string,
      string,
      number,
      string,
    ];
    const gallery = this.gallery(galleryId, workspace);
    const childExists = this.sql.includes("gallery_items")
      ? this.database.items.some((item) => item.id === childId && item.gallery_id === galleryId)
      : this.database.references.some(
          (reference) => reference.id === childId && reference.gallery_id === galleryId,
        );
    const changes = gallery && gallery.version === expectedVersion && childExists ? 1 : 0;
    if (changes && gallery) {
      gallery.version++;
      gallery.updated_at = updatedAt;
    }
    return this.mutation(changes);
  }

  private gallery(id: string, workspace: string): Gallery | undefined {
    return this.database.galleries.find(
      (gallery) =>
        gallery.id === id && gallery.workspace === workspace && gallery.deleted_at === null,
    );
  }

  private mutation(changes: number): D1Result {
    return { success: true, results: [], meta: { changes } } as unknown as D1Result;
  }

  private result<T>(results: T[]): D1Result<T> {
    return {
      success: true,
      results: results.map((result) => ({ ...result })),
      meta: {},
    } as D1Result<T>;
  }
}
