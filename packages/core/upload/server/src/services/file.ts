import path from 'path';
import fse from 'fs-extra';
import { cloneDeep } from 'lodash/fp';
import { async, errors } from '@strapi/utils';

import { FOLDER_MODEL_UID, FILE_MODEL_UID } from '../constants';
import { getService } from '../utils';

import { Config, type File } from '../types';

const { ApplicationError } = errors;

/**
 * Represents a file fetched from a URL, compatible with the upload pipeline
 */
interface UrlFetchedFile {
  filepath: string;
  originalFilename: string;
  mimetype: string;
  size: number;
  tmpWorkingDirectory?: string;
}

interface FetchUrlResult {
  file: UrlFetchedFile;
}

/**
 * Extracts filename from a URL path or Content-Disposition header
 */
const getFilenameFromUrl = (url: string, contentDisposition?: string | null): string => {
  // Try Content-Disposition header first
  if (contentDisposition) {
    // Extracts filename from Content-Disposition header (e.g. filename="photo.jpg" or filename*=UTF-8''photo.jpg)
    const filenameMatch = contentDisposition.match(
      /filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i
    );
    if (filenameMatch?.[1]) {
      return decodeURIComponent(filenameMatch[1]);
    }
  }

  // Fall back to URL path
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split('/').pop();
    if (filename && filename.length > 0) {
      return decodeURIComponent(filename);
    }
  } catch {
    // Invalid URL, use default
  }

  // Generate a timestamp-based default filename
  const now = new Date();
  const date = now.toISOString().split('T')[0]; // 2024-02-23
  const time = now.toTimeString().split(' ')[0].replace(/:/g, ''); // 143052
  return `untitled_${date}_${time}`;
};

/**
 * Fetches a URL and saves it as a temporary file
 * Returns an InputFile-compatible object for use with the upload pipeline
 */
const fetchUrlToInputFile = async (
  url: string,
  tmpWorkingDirectory: string
): Promise<FetchUrlResult> => {
  // Validate URL protocol
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ApplicationError(`Invalid URL: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new ApplicationError(`Invalid URL protocol. Only http and https are allowed: ${url}`);
  }

  // Fetch the URL
  const response = await fetch(url);

  if (!response.ok) {
    throw new ApplicationError(
      `Failed to fetch URL: ${url} (${response.status} ${response.statusText})`
    );
  }

  // Get content type and filename
  const contentType =
    response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  const contentDisposition = response.headers.get('content-disposition');
  const filename = getFilenameFromUrl(response.url, contentDisposition);

  // Read response body
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Write to temp file
  const tmpFilePath = path.join(tmpWorkingDirectory, filename);
  await fse.writeFile(tmpFilePath, buffer);

  // Create file object compatible with upload pipeline
  const fetchedFile: UrlFetchedFile = {
    filepath: tmpFilePath,
    originalFilename: filename,
    mimetype: contentType,
    size: buffer.length,
    tmpWorkingDirectory,
  };

  return { file: fetchedFile };
};

const getFolderPath = async (folderId?: number | null) => {
  if (!folderId) return '/';

  const parentFolder = await strapi.db.query(FOLDER_MODEL_UID).findOne({ where: { id: folderId } });

  return parentFolder.path;
};

const deleteByIds = async (ids: number[] = []) => {
  const filesToDelete = await strapi.db
    .query(FILE_MODEL_UID)
    .findMany({ where: { id: { $in: ids } } });

  await Promise.all(filesToDelete.map((file: File) => getService('upload').remove(file)));

  return filesToDelete;
};

const signFileUrls = async (file: File) => {
  const { provider } = strapi.plugins.upload;
  const { provider: providerConfig } = strapi.config.get<Config>('plugin::upload');
  const isPrivate = await provider.isPrivate();
  file.isUrlSigned = false;

  // Check file provider and if provider is private
  if (file.provider !== providerConfig || !isPrivate) {
    return file;
  }

  const signUrl = async (file: File) => {
    const signedUrl = await provider.getSignedUrl(file);
    file.url = signedUrl.url;
    file.isUrlSigned = true;
  };

  const signedFile = cloneDeep(file);

  // Sign each file format
  await signUrl(signedFile);
  if (file.formats) {
    await async.map(Object.values(signedFile.formats ?? {}), signUrl);
  }

  return signedFile;
};

export type { UrlFetchedFile, FetchUrlResult };
export default { getFolderPath, deleteByIds, signFileUrls, fetchUrlToInputFile };
