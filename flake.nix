{
  description = "Light Phone Manager";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        # the api/cli flakes are broken at v0.3.0 (whoops), so fetch them from PyPI
        lightPhoneApi = pkgs.python3Packages.buildPythonPackage rec {
          pname = "light-phone-api";
          version = "0.3.3";
          format = "wheel";
          src = pkgs.fetchurl {
            url = "https://files.pythonhosted.org/packages/61/fa/31e1613f14266aeeae80b012f1620af36666025abe8e526e1c447e3dc24a/light_phone_api-0.3.3-py3-none-any.whl";
            hash = "sha256-+DDPWM3iKSjC3j9wc06a/O819pzIPZ5FekOoL52aulI=";
          };
          propagatedBuildInputs = with pkgs.python3Packages; [
            attrs
            httpx
            keyring
            mutagen
            python-dateutil
          ];
          doCheck = false;
        };

        lightPhoneCliTui = pkgs.python3Packages.buildPythonPackage rec {
          pname = "light-phone-cli-tui";
          version = "0.3.3";
          format = "wheel";
          src = pkgs.fetchurl {
            url = "https://files.pythonhosted.org/packages/e2/2c/aa0ed6aa0ad8473a07f91ffb35a4532274a261c5b6878172835a522db60f/light_phone_cli_tui-0.3.3-py3-none-any.whl";
            hash = "sha256-WEP2MdsDhL/SpOvP1YuLLxqABZkxb99I1AY0ooyGMcI=";
          };
          propagatedBuildInputs = with pkgs.python3Packages; [
            click
            inquirerpy
            lightPhoneApi
            rapidfuzz
            rich
            rich-click
          ];
          doCheck = false;
        };

        # Python env with light_cli_tui importable.
        # Symlinked into `resources/light-cli/`, where LPM looks for a bundled python.
        lightPythonEnv = pkgs.python3.withPackages (_: [ lightPhoneCliTui ]);
      in
      {
        packages.default = pkgs.buildNpmPackage {
          pname = "light-phone-manager";
          version = "1.2.0";
          src = ./.;

          npmDepsHash = "sha256-gJ1aDrvb4YVIWueM/47EfxyienLFubth0a7YyOAbt80=";

          # Only production deps are needed at runtime, since electron and
          # electron-builder (devDependencies) are provided by nixpkgs
          npmFlags = [ "--omit=dev" ];
          dontNpmBuild = true;
          env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

          nativeBuildInputs = [ pkgs.makeWrapper ];

          installPhase = ''
            runHook preInstall

            mkdir -p $out/share/light-phone-manager
            cp -r . $out/share/light-phone-manager

            mkdir -p $out/share/light-phone-manager/resources/light-cli/linux/python/bin
            ln -s ${lightPythonEnv}/bin/python3 \
              $out/share/light-phone-manager/resources/light-cli/linux/python/bin/python3

            makeWrapper ${pkgs.electron}/bin/electron $out/bin/light-phone-manager \
              --add-flags "$out/share/light-phone-manager" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.android-tools ]}

            # register the lpm:// deep link handler
            mkdir -p $out/share/applications
            cat > $out/share/applications/light-phone-manager.desktop <<EOF
            [Desktop Entry]
            Type=Application
            Name=Light Phone Manager
            Comment=Desktop client for managing your Light Phone 3
            Exec=$out/bin/light-phone-manager %u
            Icon=light-phone-manager
            Terminal=false
            Categories=Utility;
            MimeType=x-scheme-handler/lpm;
            EOF

            mkdir -p $out/share/icons/hicolor/512x512/apps
            cp build/icon.png $out/share/icons/hicolor/512x512/apps/light-phone-manager.png

            runHook postInstall
          '';

          meta = {
            description = "Manage your Light Phone 3";
            homepage = "https://github.com/greghare/light-phone-manager";
            license = pkgs.lib.licenses.mit;
            mainProgram = "light-phone-manager";
            platforms = pkgs.lib.platforms.linux;

            # maintainers for the flake (not for LPM itself)
            maintainers = [
              {
                name = "garado";
                github = "garado";
                email = "alexisgarado@gmail.com";
              }
            ];
          };
        };

        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/light-phone-manager";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.electron
            pkgs.android-tools
          ];

          # use the Electron binary provided by nixpkgs instead of letting
          # the `electron` npm package download its own during `npm install`
          shellHook = ''
            export ELECTRON_OVERRIDE_DIST_PATH="${pkgs.electron}/bin/"
            echo "Light Phone Manager dev shell"
            echo "  npm install"
            echo "  npm run fetch-platform-tools   # downloads adb into resources/ (or rely on android-tools on PATH)"
            echo "  npm start"
          '';
        };
      }
    );
}
