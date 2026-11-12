"""File primitives used by the pinned XASP Desktop runtime."""

import os
import stat
from pathlib import Path


if os.name == "nt":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    class AttributeTagInfo(ctypes.Structure):
        _fields_ = [("attributes", wintypes.DWORD), ("tag", wintypes.DWORD)]

    class Overlapped(ctypes.Structure):
        _fields_ = [
            ("internal", ctypes.c_size_t),
            ("internal_high", ctypes.c_size_t),
            ("offset", wintypes.DWORD),
            ("offset_high", wintypes.DWORD),
            ("event", wintypes.HANDLE),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    create_file.restype = wintypes.HANDLE
    get_file_type = kernel32.GetFileType
    get_file_type.argtypes = [wintypes.HANDLE]
    get_file_type.restype = wintypes.DWORD
    get_file_info = kernel32.GetFileInformationByHandleEx
    get_file_info.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    get_file_info.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL
    lock_file = kernel32.LockFileEx
    lock_file.argtypes = [wintypes.HANDLE, *([wintypes.DWORD] * 4), ctypes.POINTER(Overlapped)]
    lock_file.restype = wintypes.BOOL
    move_file = kernel32.MoveFileExW
    move_file.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    move_file.restype = wintypes.BOOL

    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    FILE_ATTRIBUTE_DIRECTORY = 0x10
    FILE_ATTRIBUTE_REPARSE_POINT = 0x400
    FILE_FLAG_OPEN_REPARSE_POINT = 0x200000
    FILE_SHARE_READ = 0x1
    FILE_TYPE_DISK = 0x1
    GENERIC_READ = 0x80000000
    OPEN_EXISTING = 0x3
    FILE_ATTRIBUTE_TAG_INFO_CLASS = 0x9
    LOCKFILE_EXCLUSIVE_LOCK = 0x2
    LOCKFILE_FAIL_IMMEDIATELY = 0x1
    ERROR_LOCK_VIOLATION = 33
    MOVEFILE_REPLACE_EXISTING = 0x1
    MOVEFILE_WRITE_THROUGH = 0x8
else:
    import fcntl


def _windows_path(value):
    """Reject device, UNC and alternate stream paths for local Desktop files."""
    path = Path(os.path.abspath(value))
    if (
        len(path.drive) != 2 or path.drive[1] != ":" or not path.drive[0].isascii()
        or not path.drive[0].isalpha() or not path.name
        or any(":" in part or Path(part).is_reserved() for part in path.parts[1:])
    ):
        raise OSError("OA file must use a regular local drive path")
    return "\\\\?\\" + str(path)


def open_regular(path):
    """Return an opened descriptor checked for a regular file at its final path."""
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise OSError("not a regular file")
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    handle = create_file(
        _windows_path(path), GENERIC_READ, FILE_SHARE_READ, None,
        OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, None,
    )
    if handle == INVALID_HANDLE_VALUE:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        info = AttributeTagInfo()
        if not get_file_info(handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, ctypes.byref(info), ctypes.sizeof(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        if get_file_type(handle) != FILE_TYPE_DISK or info.attributes & (
            FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT
        ):
            raise OSError("not a regular file")
        # Ownership moves to the descriptor only after successful conversion.
        return msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY | os.O_NOINHERIT)
    except BaseException:
        close_handle(handle)
        raise


def exclusive_lock(descriptor, *, wait=True):
    """Keep the process lock until the descriptor closes."""
    if os.name != "nt":
        fcntl.flock(descriptor, fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
        return
    flags = LOCKFILE_EXCLUSIVE_LOCK if wait else LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY
    if lock_file(msvcrt.get_osfhandle(descriptor), flags, 0, 1, 0, ctypes.byref(Overlapped())):
        return
    error = ctypes.get_last_error()
    if error == ERROR_LOCK_VIOLATION and not wait:
        raise BlockingIOError("OA journal is already locked")
    raise ctypes.WinError(error)


def replace_private_file(source, destination):
    """Atomically publish fsynced state on the same volume."""
    if os.name == "nt":
        if not move_file(
            _windows_path(source), _windows_path(destination),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        return
    os.replace(source, destination)
    directory = os.open(Path(destination).parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
