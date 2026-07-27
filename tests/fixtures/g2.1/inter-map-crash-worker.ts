import path from "node:path";
import {
  ArtifactStore,
  createArtifactValidator,
  type DiscoveryProfile,
  type PublishArtifactInput,
  type PublishArtifactResult,
} from "../../../harness/src/index.js";
import {
  createDiscoveryMapsFixture,
  fixtureEnvelope,
  G21_MAP_REFS,
} from "./discovery-maps-fixture.js";

const EXIT_AFTER_FIRST_MAP = 86;

class InterMapCrashStore extends ArtifactStore {
  private publishedMapCount = 0;

  override async publishLocked(
    runRoot: string,
    input: PublishArtifactInput,
    referencesPrevalidated = false,
  ): Promise<PublishArtifactResult> {
    const result = await super.publishLocked(runRoot, input, referencesPrevalidated);
    this.publishedMapCount += 1;
    if (this.publishedMapCount === 1) {
      process.exit(EXIT_AFTER_FIRST_MAP);
    }
    return result;
  }
}

const [runsRoot, runId, profileValue] = process.argv.slice(2);
if (runsRoot === undefined || runId === undefined || profileValue === undefined) {
  throw new Error("runs root, run id, and discovery profile are required");
}

const profile = profileValue as DiscoveryProfile;
const validator = await createArtifactValidator(process.cwd());
const bundle = await createDiscoveryMapsFixture(profile, runId);
const store = new InterMapCrashStore(runsRoot, validator);

await store.publishBundle({
  runId,
  envelopes: G21_MAP_REFS.map((ref) => fixtureEnvelope(bundle, ref)),
});

throw new Error(
  `inter-map crash worker unexpectedly published every map under ${path.basename(runId)}`,
);
