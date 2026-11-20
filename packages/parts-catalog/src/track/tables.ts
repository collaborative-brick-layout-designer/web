// The track tables (trains design 2.1, 3.2): word for word the shared
// contracts fixtures/contracts/track-kinds.json and track-paths.json (the
// desktop keeps the same files in src/track/data/). tables.test.ts checks
// they match.

export interface TrackKindDefaults {
  /** Car body width, studs. */
  carWidth: number;
  /** How far apart two tracks' centrelines must be for cars to pass, studs. */
  clearance: number;
  /** The scale speeds are shown at (1:scale). */
  scale: number;
  /** How far a truck may swivel under a car, degrees. */
  swivelMax: number;
}

export interface TrackKindsTable {
  _about: string;
  kinds: Record<string, TrackKindDefaults>;
  types: Record<string, string>;
  prefixes: Record<string, string>;
  notTrack: string[];
  fallback: string;
  maxTurnDegrees: number;
}

export interface TrackPathsTable {
  _about: string;
  parts: Record<string, { paths: [number, number][]; note?: string }>;
}

export const TRACK_KINDS: TrackKindsTable = {
  "_about": "Which connection types are track, and what kind (trains design 2.1). Both apps read this (web packages/parts-catalog/src/track/tables.ts, desktop src/track/data/track-kinds.json; both tests check their copy). A type is looked up in order: notTrack, types, prefixes; failing those, a type in one of a part's electric circuits counts as `fallback`, so new 9V-style packages work without an update. Anything else is not track. Within one part, a path joins two connections of the same kind; between parts, connections link only when their types match (BlueBrick). maxTurnDegrees: a part with three or more track connections and no circuits has a path from i to j when entering at i and leaving at j turns at most this much.",
  "kinds": {
    "rail": {
      "carWidth": 6,
      "clearance": 8,
      "scale": 38,
      "swivelMax": 30
    },
    "monorail": {
      "carWidth": 4,
      "clearance": 5,
      "scale": 38,
      "swivelMax": 45
    },
    "duplo": {
      "carWidth": 8,
      "clearance": 10,
      "scale": 38,
      "swivelMax": 30
    },
    "narrow": {
      "carWidth": 4,
      "clearance": 6,
      "scale": 38,
      "swivelMax": 30
    },
    "coaster": {
      "carWidth": 4,
      "clearance": 6,
      "scale": 38,
      "swivelMax": 45
    },
    "plarail": {
      "carWidth": 4,
      "clearance": 6,
      "scale": 38,
      "swivelMax": 30
    }
  },
  "types": {
    "1": "rail",
    "trixbrix_ng": "rail",
    "trixbrix_bridge": "rail",
    "5": "duplo",
    "narrow": "narrow",
    "3": "monorail",
    "mono": "monorail",
    "mono45": "monorail",
    "monoramp": "monorail",
    "coaster": "coaster",
    "plarail": "plarail"
  },
  "prefixes": {
    "trixbrix_sw_": "rail",
    "NT_SPLIT": "rail"
  },
  "notTrack": [
    "",
    "0",
    "2",
    "16x16road",
    "magnet",
    "flexpivot",
    "halfhinge",
    "threequarterhinge",
    "trixbrix_switchmotor",
    "trixbrix_mils",
    "bricktracks_lever",
    "NT_SPLITTER",
    "NT_TRIPLESPLITTER"
  ],
  "fallback": "rail",
  "maxTurnDegrees": 60
};

export const TRACK_PATHS: TrackPathsTable = {
  "_about": "The ways through a part where the rules (trains design 3.2: electric circuits, two connections, the turn limit) would be wrong or need saying outright. Keys are library keys (part number and color, compared ignoring case); `paths` lists connection index pairs, each usable both ways. Both apps read this (web packages/parts-catalog/src/track/tables.ts, desktop src/track/data/track-paths.json; both tests check their copy). A part may also say it in its own XML with <TrackPaths> (not read yet).",
  "parts": {
    "TS_MONORAILCROSS.7": {
      "paths": [
        [
          0,
          1
        ],
        [
          2,
          3
        ]
      ],
      "note": "4DBrix monorail crossing: straight through both ways, never round the corner."
    }
  }
};
