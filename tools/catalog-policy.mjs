/** A same-version build is development work, never an implicit replacement release. */
export function retainedEntry(previous, manifest) {
  return previous?.releases?.[0]?.version === manifest.version ? previous : null
}
