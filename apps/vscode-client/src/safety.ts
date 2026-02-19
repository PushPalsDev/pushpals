const DOCKER_IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/;

export function validateDockerImageName(rawImage: string): string {
  const image = rawImage.trim();
  if (!image) {
    throw new Error("Worker Docker image cannot be empty.");
  }
  if (!DOCKER_IMAGE_PATTERN.test(image)) {
    throw new Error(
      `Invalid worker Docker image '${image}'. Use only letters, digits, '.', '_', '/', ':', '@', and '-'.`,
    );
  }
  return image;
}

export function formatCommandForLog(command: string, args: readonly string[]): string {
  const rendered = args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
  return [command, ...rendered].join(" ");
}
