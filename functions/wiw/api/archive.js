import {relayArchive} from '../../../wiw/archive_gateway.mjs';

export function onRequest({request}) {
  return relayArchive(request);
}
