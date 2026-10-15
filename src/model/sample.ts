import { parseOutline } from './bulk';
import { withDatatype } from './domains';
import { arrangeAsHierarchy } from '../layout/graph';
import { emptyModel, newProp, newRelation, newTerm, type Model, type RelKind, type TermType } from './types';

/** A small film-industry knowledge graph used as the starting example. */
export function sampleModel(): Model {
  const m = emptyModel('Film knowledge graph');
  m.description = 'Example model. Edit it freely, or start from scratch with File → New.';
  const id: Record<string, string> = {};
  const term = (name: string, description: string, type: TermType = 'concept', color = '') => {
    const t = newTerm({ name, description, type, color });
    id[name] = t.id;
    m.terms.push(t);
  };
  const rel = (from: string, label: string, to: string, kind: RelKind = 'association', fromCard = '', toCard = '') =>
    m.relations.push(newRelation({ from: id[from], to: id[to], label, kind, fromCard, toCard }));

  term('Person', 'A human being involved in making films.', 'concept', 'blue');
  term('Actor', 'A person who performs a role in a film.', 'concept', 'blue');
  term('Director', 'A person who controls the artistic and dramatic aspects of a film.', 'concept', 'blue');
  term('Film', 'A story recorded as moving images, shown in cinemas or on streaming platforms.', 'concept', 'amber');
  term('Documentary', 'A non-fiction film that documents reality.', 'concept', 'amber');
  term('Studio', 'A company that produces and distributes films.', 'concept', 'green');
  term('Genre', 'A category of films sharing style or subject matter.', 'concept', 'purple');
  term('Award', '', 'concept', 'pink');
  term('Release date', 'The day a film first became available to the public.', 'property');
  term('Running time', 'Length of the film in minutes.', 'property');
  term('Parasite', 'South Korean film from 2019, directed by Bong Joon-ho.', 'instance');

  m.terms.find((t) => t.name === 'Release date')!.ranges = withDatatype({}, 'xsd:date');
  m.terms.find((t) => t.name === 'Running time')!.ranges = withDatatype({}, 'xsd:integer');

  rel('Actor', '', 'Person', 'generalization');
  rel('Director', '', 'Person', 'generalization');
  rel('Documentary', '', 'Film', 'generalization');
  rel('Parasite', '', 'Film', 'generalization');
  rel('Actor', 'acts in', 'Film');
  rel('Director', 'directs', 'Film');
  rel('Studio', 'produces', 'Film');
  rel('Film', 'belongs to', 'Genre');
  rel('Film', 'wins', 'Award');
  rel('Film', '', 'Release date', 'property');
  rel('Film', '', 'Running time', 'property');

  m.props = [
    newProp({ name: 'acts in', description: 'Performs a role in a film.' }),
    newProp({ name: 'directs', description: 'Is the director of a film.' }),
    newProp({ name: 'produces' }),
    newProp({ name: 'belongs to' }),
    newProp({ name: 'wins' }),
  ];

  arrangeAsHierarchy(m);
  return m;
}

/** A small thesaurus used as the SKOS starting example. */
export function skosSample(): Model {
  const m = emptyModel('Musical instruments');
  m.mode = 'skos';
  m.lang = 'en';
  m.description = 'Example concept scheme. Edit it freely, or start from scratch with File → New.';
  const outline = parseOutline(`Musical instruments
  String instruments
    Bowed strings
      Violin
      Cello
    Plucked strings
      Guitar
      Harp
  Wind instruments
    Woodwind
      Flute
      Clarinet
    Brass
      Trumpet
  Percussion
    Drum
Musicians
  Violinist
  Guitarist`);
  const id: Record<string, string> = {};
  const colours = ['amber', 'blue', 'green', 'purple'];
  for (const name of outline.terms) {
    const t = newTerm({ name });
    id[name] = t.id;
    m.terms.push(t);
  }
  for (const r of outline.rels) m.relations.push(newRelation({ from: id[r.from], to: id[r.to], kind: 'generalization' }));
  const term = (name: string) => m.terms.find((t) => t.name === name)!;
  ['String instruments', 'Wind instruments', 'Percussion', 'Musicians'].forEach((n, i) => (term(n).color = colours[i]));
  Object.assign(term('Violin'), {
    description: 'A four-stringed instrument played with a bow, the smallest of the violin family.',
    synonyms: 'Fiddle',
    fields: [
      { key: 'skos:prefLabel', value: 'Viool', lang: 'nl' },
      { key: 'skos:prefLabel', value: '小提琴', lang: 'zh' },
      { key: 'skos:notation', value: '321.322-71' },
      { key: 'skos:exactMatch', value: 'http://www.wikidata.org/entity/Q8355' },
    ],
  });
  term('Guitar').description = 'A fretted instrument, usually with six strings, played by plucking or strumming.';
  m.relations.push(
    newRelation({ from: id['Violinist'], to: id['Violin'], predicate: 'skos:related' }),
    newRelation({ from: id['Guitarist'], to: id['Guitar'], predicate: 'skos:related' }),
  );
  arrangeAsHierarchy(m);
  return m;
}
