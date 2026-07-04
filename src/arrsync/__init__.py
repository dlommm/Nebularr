from importlib.metadata import PackageNotFoundError, version

__all__ = ["__version__"]

try:
    __version__ = version("nebularr")
except PackageNotFoundError:  # running from a source checkout without installation
    __version__ = "0.0.0.dev0"
