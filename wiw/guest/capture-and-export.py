#!/usr/bin/env python3
"""Publish a browser replay snapshot directly from the configured guest files."""
import json
from pathlib import Path
import sys

from prepare import encode_json, include_paths, snapshot_bytes, workflow
from capture import run_batch


def main():
    batch, destination = map(Path, sys.argv[1:])
    profile = destination / 'include-paths.json'
    includes = (json.loads(profile.read_bytes()) if profile.is_file() else
                {language: include_paths(language) for language in ('c', 'c++')})

    def publish(plan, root, files, output):
        project = plan['project']['id']
        cwl = workflow(plan, root, includes, set())
        (output / (project + '.cwl')).write_bytes(encode_json(cwl))
        snapshot = {
            str(path).lstrip('/'): path.read_bytes()
            for path in files if path.is_file() and path.resolve().is_relative_to(root)
        }
        # Both workers are local to the same browser. Avoid compressing
        # and inflating the workspace when it never crosses the network.
        (output / (project + '.bin')).write_bytes(snapshot_bytes(snapshot))
        (output / 'sdk.json').write_bytes(encode_json({**plan['sdk'], 'target': plan['target']}))

    run_batch(batch, destination, publish)


if __name__ == '__main__':
    main()
