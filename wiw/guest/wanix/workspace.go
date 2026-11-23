// Snapshot a guest workspace, sending file contents only when they change.
package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

const maxWorkspace = 128 << 20

func writeChanged(archive *tar.Writer, path, name string, info fs.FileInfo, previous string, remaining int64, buffer []byte) (string, int64, error) {
	if info.Mode()&fs.ModeSymlink != 0 {
		link, err := os.Readlink(path)
		if err != nil {
			return "", 0, err
		}
		digest := sha256.Sum256([]byte(link))
		value := "l" + base64.RawStdEncoding.EncodeToString(digest[:])
		if previous != value {
			err = writeHeader(archive, name, info, link, 0)
		}
		return value, int64(len(link)), err
	}
	if !info.Mode().IsRegular() {
		return "", 0, fmt.Errorf("unsupported workspace entry: %s", name)
	}
	input, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer input.Close()
	digest := sha256.New()
	size, err := io.CopyBuffer(digest, io.LimitReader(input, remaining+1), buffer)
	if err != nil {
		return "", 0, err
	}
	if size > remaining {
		return "", 0, errors.New("the configured workspace is too large")
	}
	value := "f" + base64.RawStdEncoding.EncodeToString(digest.Sum(nil))
	if previous == value {
		return value, size, nil
	}
	if _, err := input.Seek(0, io.SeekStart); err != nil {
		return "", 0, err
	}
	if err := writeHeader(archive, name, info, "", size); err != nil {
		return "", 0, err
	}
	// Hash the bytes sent to the browser, even if the file changed during the scan.
	digest.Reset()
	count, err := io.CopyBuffer(io.MultiWriter(archive, digest), io.LimitReader(input, size), buffer)
	if err == nil && count != size {
		err = io.ErrUnexpectedEOF
	}
	return "f" + base64.RawStdEncoding.EncodeToString(digest.Sum(nil)), size, err
}

func writeHeader(archive *tar.Writer, name string, info fs.FileInfo, link string, size int64) error {
	header, err := tar.FileInfoHeader(info, link)
	if err != nil {
		return err
	}
	header.Name, header.Format, header.Size = name, tar.FormatGNU, size
	return archive.WriteHeader(header)
}

func snapshot(root, statePath, archivePath string) error {
	var previous map[string]string
	state, err := os.ReadFile(statePath)
	if err == nil {
		if err := json.Unmarshal(state, &previous); err != nil {
			return err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}

	output, err := os.Create(archivePath)
	if err != nil {
		return err
	}
	defer output.Close()
	compressed, err := gzip.NewWriterLevel(output, gzip.BestSpeed)
	if err != nil {
		return err
	}
	archive := tar.NewWriter(compressed)
	current := make(map[string]string)
	buffer := make([]byte, 64*1024)
	total := int64(0)
	err = filepath.WalkDir(root, func(path string, file fs.DirEntry, err error) error {
		if err != nil || file.IsDir() {
			return err
		}
		name, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		info, err := file.Info()
		if err != nil {
			return err
		}
		if len(current) >= 100000 || info.Size() > maxWorkspace-total {
			return errors.New("the configured workspace is too large")
		}
		value, size, err := writeChanged(archive, path, name, info, previous[name], maxWorkspace-total, buffer)
		if err != nil {
			return err
		}
		total += size
		if total > maxWorkspace {
			return errors.New("the configured workspace is too large")
		}
		current[name] = value
		return nil
	})
	if err != nil {
		return err
	}
	if err := archive.Close(); err != nil {
		return err
	}
	if err := compressed.Close(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}

	removed := []string{}
	for name := range previous {
		if _, exists := current[name]; !exists {
			removed = append(removed, name)
		}
	}
	sort.Strings(removed)
	state, err = json.Marshal(current)
	if err != nil {
		return err
	}
	if err := os.WriteFile(statePath, state, 0600); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(removed)
}

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "usage: workspace WORKSPACE CACHE ARCHIVE")
		os.Exit(2)
	}
	if err := snapshot(os.Args[1], os.Args[2], os.Args[3]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
