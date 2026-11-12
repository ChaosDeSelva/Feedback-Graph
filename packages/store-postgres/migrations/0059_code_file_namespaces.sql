-- A C# file's namespaces, kept with the code map so a rebuild reads an unchanged file's without parsing it again
-- (core MapFile.namespaces). Null for any other file, and for a C# file of a map built before code map version 6.
ALTER TABLE code_files ADD COLUMN cs_namespaces text[];
