import {boundedBytes, recipe, remote} from './plans.mjs';

export async function projectSource(project, signal, log, target) {
  log('Fetching the source archive for ' + project.commit.slice(0, 10));
  const query = new URLSearchParams({repo:project.repo, sha:project.commit});
  const [archive, config] = await Promise.all([
    remote(new URL('api/archive?' + query, import.meta.url), signal).then(response => boundedBytes(response, 96 * 1024 * 1024)),
    recipe(project, signal, target),
  ]);
  return {archive, config};
}
