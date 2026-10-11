// The SHACL engine and the RDF environment it needs, as one module, so that they are fetched
// together the first time something is validated with SHACL and not before.
import rdf from '@zazuko/env/web.js';
import SHACLValidator from 'rdf-validate-shacl';

export { rdf, SHACLValidator };
