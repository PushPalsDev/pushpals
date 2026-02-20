import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from executor_base import SettingsResolver, build_settings_resolver


class SettingsResolverTests(unittest.TestCase):
    def test_get_str_prefers_env_then_config(self) -> None:
        resolver = SettingsResolver(
            env={"A": "  env-value  "},
            config_loader=lambda: {"root": {"value": "toml-value"}},
        )
        value = resolver.get_str(
            env_names=("A",),
            config_paths=("root.value",),
            default="fallback",
        )
        self.assertEqual(value, "env-value")

    def test_get_str_uses_first_present_config_path(self) -> None:
        resolver = SettingsResolver(
            env={},
            config_loader=lambda: {"root": {"secondary": "value-2"}},
        )
        value = resolver.get_str(
            config_paths=("root.primary", "root.secondary"),
            default="fallback",
        )
        self.assertEqual(value, "value-2")

    def test_numeric_and_boolean_parsing(self) -> None:
        resolver = SettingsResolver(
            env={"INT_ENV": "42", "BOOL_ENV": "true"},
            config_loader=lambda: {"root": {"int": "9", "enabled": False}},
        )
        self.assertEqual(
            resolver.get_int(env_names=("INT_ENV",), config_paths=("root.int",), default=0),
            42,
        )
        self.assertTrue(
            resolver.get_bool(env_names=("BOOL_ENV",), config_paths=("root.enabled",), default=False),
        )

    def test_build_settings_resolver_static_config(self) -> None:
        resolver = build_settings_resolver(
            env={"X": ""},
            config={"root": {"flag": "on"}},
        )
        self.assertTrue(
            resolver.get_bool(env_names=("X",), config_paths=("root.flag",), default=False),
        )


if __name__ == "__main__":
    unittest.main()
