import { toJsonLd, toTurtle } from '../model/rdf';
import { asTurtle, detectFormat, writeWithService } from '../model/rdfFormats';
import { rdfXmlOf } from '../model/rdfxml';
import { SYNTAXES, type ImportExportService } from './contracts';

/**
 * The import and export service of the editor: Turtle and JSON-LD written by the app's own writer,
 * RDF/XML from that Turtle in the page (rdfxml.ts), and OWL/XML, functional and Manchester syntax
 * by the local OWL service, given the same Turtle (writeWithService). Every syntax is written
 * from the one Turtle, so that they all state the same.
 */
export function createLocalImportExportService(options: { serviceUrl: () => string; fetch?: typeof fetch }): ImportExportService {
  return {
    detect: (text, name, contentType) => detectFormat(text, name, contentType),
    read: (text, name) => asTurtle(text, { name, serviceUrl: options.serviceUrl(), ...(options.fetch ? { fetch: options.fetch } : {}) }),
    async write(model, syntax) {
      const about = SYNTAXES.find((s) => s.id === syntax)!;
      const turtle = toTurtle(model);
      const text =
        syntax === 'turtle'
          ? turtle
          : syntax === 'jsonld'
            ? toJsonLd(model)
            : syntax === 'rdfxml'
              ? rdfXmlOf(turtle)
              : await writeWithService(turtle, syntax, { serviceUrl: options.serviceUrl(), ...(options.fetch ? { fetch: options.fetch } : {}) });
      return { text, syntax, extension: about.extension, mediaType: about.mediaType };
    },
  };
}
