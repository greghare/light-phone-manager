{
  description = "Light Phone Manager";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    light.url = "github:garado/light";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
    light,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs {inherit system;};

      lightCli = light.packages.${system}.light-phone-cli-tui;

      # Python env with light_cli_tui importable.
      # Symlinked into `resources/light-cli/`, where LPM looks for a bundled python.
      lightPythonEnv = lightCli.pythonModule.withPackages (_: [lightCli]);
    in {
      packages.default = pkgs.buildNpmPackage {
        pname = "light-phone-manager";
        version = "1.1.0";
        src = ./.;

        npmDepsHash = "sha256-y/kvfml3v0vOeL1Vx/dCXrCvZn63cWZX2PZKym4OSr8=";

        # Only production deps are needed at runtime, since electron and
        # electron-builder (devDependencies) are provided by nixpkgs
        npmFlags = ["--omit=dev"];
        dontNpmBuild = true;
        env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

        nativeBuildInputs = [pkgs.makeWrapper];

        installPhase = ''
          runHook preInstall

          mkdir -p $out/share/light-phone-manager
          cp -r . $out/share/light-phone-manager

          mkdir -p $out/share/light-phone-manager/resources/light-cli/linux/python/bin
          ln -s ${lightPythonEnv}/bin/python3 \
            $out/share/light-phone-manager/resources/light-cli/linux/python/bin/python3

          makeWrapper ${pkgs.electron}/bin/electron $out/bin/light-phone-manager \
            --add-flags "$out/share/light-phone-manager" \
            --prefix PATH : ${pkgs.lib.makeBinPath [pkgs.android-tools]}

          runHook postInstall
        '';

        meta = {
          description = "Manage sideloaded tools on your Light Phone 3";
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
    });
}
