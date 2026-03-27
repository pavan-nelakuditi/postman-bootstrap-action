export async function fetchFlowManifest(
  url: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/yaml, text/yaml, text/plain, application/x-yaml, */*'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch flow manifest (${response.status} ${response.statusText})`);
  }

  return response.text();
}
