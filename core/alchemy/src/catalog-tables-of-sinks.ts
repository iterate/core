// catalog-tables-of-sinks.ts — THE TABLES THAT THE STACK'S SINKS WRITE, AS A RESOURCE. A catalog
// sink makes its own Iceberg table, and Cloudflare makes no sink for a table that exists
// ("writing to existing Catalog tables is not yet supported"). R2 keeps a catalog's tables when
// the catalog is turned off and when its bucket is deleted, and gives them back to a new bucket
// of the same name. So a stage that was destroyed could not deploy again.
//
// This resource makes nothing. The sinks take their tables' namespace from it, so a destroy
// deletes the pipelines and the sinks first, then drops the tables here, and then turns the
// catalog off. Alchemy's own `Cloudflare.Basin.Table` cannot stand in: it makes the table, which
// a sink then refuses (2.0.0-beta.85).
import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import { z } from "zod";

export type CatalogTablesOfSinks = Resource<
  "Iterate.CatalogTablesOfSinks",
  {
    /** The data catalog's Iceberg address and its id (`Cloudflare.R2.DataCatalog`'s outputs). */
    catalogUri: string;
    catalogId: string;
    /** An API token that may write the catalog. */
    token: Redacted.Redacted<string>;
    /** The Iceberg namespace of the tables, and each table's name. */
    namespace: string;
    tables: string[];
  },
  { namespace: string },
  never,
  Cloudflare.Providers
>;
export const CatalogTablesOfSinks = Resource<CatalogTablesOfSinks>("Iterate.CatalogTablesOfSinks");

/** The Iceberg REST catalog's list of a namespace's tables. */
const TablesOfNamespace = z.object({ identifiers: z.array(z.object({ name: z.string() })) });

export const CatalogTablesOfSinksProvider = () =>
  Provider.succeed(CatalogTablesOfSinks, {
    reconcile: ({ news }) => Effect.succeed({ namespace: news.namespace }),
    delete: Effect.fn(function* ({ olds }) {
      const http = yield* HttpClient.HttpClient;
      const namespace = `${olds.catalogUri}/v1/${olds.catalogId}/namespaces/${olds.namespace}`;
      const catalog = (method: "GET" | "DELETE", url: string) =>
        http.execute(
          HttpClientRequest.make(method)(url, {
            headers: { authorization: `Bearer ${Redacted.value(olds.token)}` },
          }),
        );
      // Listed first: the catalog answers a drop of a table that is not there with a 403, which
      // also means "not allowed". A namespace that is not there (404) holds no table.
      const listed = yield* catalog("GET", `${namespace}/tables`);
      if (listed.status === 404) return;
      const tables = TablesOfNamespace.safeParse(listed.status === 200 && (yield* listed.json));
      if (!tables.success)
        return yield* Effect.die(
          `Cloudflare's data catalog did not list the tables of ${namespace} (${listed.status}): ${(yield* listed.text).slice(0, 300)}`,
        );
      const there = tables.data.identifiers.map(({ name }) => name);
      // each table of the sinks, then the namespace when it holds no other table
      for (const url of [
        ...olds.tables
          .filter((table) => there.includes(table))
          .map((table) => `${namespace}/tables/${table}`),
        ...(there.every((table) => olds.tables.includes(table)) ? [namespace] : []),
      ]) {
        const gone = yield* catalog("DELETE", url);
        if (gone.status >= 300 && gone.status !== 404)
          return yield* Effect.die(
            `Cloudflare's data catalog did not drop ${url} (${gone.status}): ${(yield* gone.text).slice(0, 300)}`,
          );
      }
    }),
  });
