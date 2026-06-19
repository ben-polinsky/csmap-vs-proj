#include <proj.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
#include "cs_map.h"
}

struct Point {
  std::string name;
  double lon;
  double lat;
};

struct XY {
  double x;
  double y;
};

static std::string optionValue(int argc, char** argv, const char* name, const char* fallback) {
  for (int i = 1; i + 1 < argc; ++i) {
    if (std::strcmp(argv[i], name) == 0) {
      return argv[i + 1];
    }
  }
  return fallback;
}

static XY transformWithProj(PJ* transform, const Point& point) {
  proj_errno_reset(transform);
  PJ_COORD input = proj_coord(point.lon, point.lat, 0.0, 0.0);
  PJ_COORD output = proj_trans(transform, PJ_FWD, input);
  int err = proj_errno(transform);
  if (err != 0) {
    throw std::runtime_error(std::string("PROJ transform failed: ") + proj_errno_string(err));
  }
  if (!std::isfinite(output.xy.x) || !std::isfinite(output.xy.y)) {
    throw std::runtime_error("PROJ transform returned a non-finite coordinate");
  }
  return {output.xy.x, output.xy.y};
}

static XY transformWithCsMap(const Point& point) {
  double coord[3] = {point.lon, point.lat, 0.0};
  int status = CS_cnvrt("LL84", "WGS84.PseudoMercator", coord);
  if (status != 0) {
    throw std::runtime_error("CS-MAP transform failed with status " + std::to_string(status));
  }
  if (!std::isfinite(coord[0]) || !std::isfinite(coord[1])) {
    throw std::runtime_error("CS-MAP transform returned a non-finite coordinate");
  }
  return {coord[0], coord[1]};
}

int main(int argc, char** argv) {
  const std::string csmapDictionaryDir =
      optionValue(argc, argv, "--csmap-dict", "vendor/csmap/CsMapDev/Dictionaries");

  try {
    if (CS_altdr(csmapDictionaryDir.c_str()) != 0) {
      throw std::runtime_error("CS_altdr failed for dictionary dir: " + csmapDictionaryDir);
    }

    PJ_CONTEXT* context = proj_context_create();
    if (context == nullptr) {
      throw std::runtime_error("proj_context_create failed");
    }

    PJ* raw = proj_create_crs_to_crs(context, "EPSG:4326", "EPSG:3857", nullptr);
    if (raw == nullptr) {
      proj_context_destroy(context);
      throw std::runtime_error("proj_create_crs_to_crs failed for EPSG:4326 -> EPSG:3857");
    }

    PJ* transform = proj_normalize_for_visualization(context, raw);
    proj_destroy(raw);
    if (transform == nullptr) {
      proj_context_destroy(context);
      throw std::runtime_error("proj_normalize_for_visualization failed");
    }

    const std::vector<Point> points = {
        {"Philadelphia", -75.165222, 39.952583},
        {"Denver", -104.990250, 39.739236},
        {"London", -0.127600, 51.507200},
        {"Sydney", 151.209300, -33.868800},
        {"High latitude", 0.000000, 85.000000},
    };

    std::cout << "CS-MAP dictionary: " << csmapDictionaryDir << "\n";
    std::cout << "PROJ version: " << proj_info().version << "\n";
    std::cout << "Comparison: CS-MAP LL84 -> WGS84.PseudoMercator vs PROJ EPSG:4326 -> EPSG:3857\n\n";

    std::cout << std::fixed << std::setprecision(3);
    std::cout << std::left << std::setw(16) << "point" << std::right << std::setw(16)
              << "csmap_x" << std::setw(16) << "csmap_y" << std::setw(16) << "proj_x"
              << std::setw(16) << "proj_y" << std::setw(12) << "delta_m" << "\n";

    double maxDelta = 0.0;
    for (const Point& point : points) {
      XY csmap = transformWithCsMap(point);
      XY proj = transformWithProj(transform, point);
      double dx = csmap.x - proj.x;
      double dy = csmap.y - proj.y;
      double delta = std::hypot(dx, dy);
      maxDelta = std::max(maxDelta, delta);

      std::cout << std::left << std::setw(16) << point.name << std::right << std::setw(16)
                << csmap.x << std::setw(16) << csmap.y << std::setw(16) << proj.x
                << std::setw(16) << proj.y << std::setw(12) << delta << "\n";
    }

    std::cout << "\nmax_delta_m=" << maxDelta << "\n";

    proj_destroy(transform);
    proj_context_destroy(context);
    CS_recvr();

    return maxDelta <= 0.001 ? EXIT_SUCCESS : EXIT_FAILURE;
  } catch (const std::exception& error) {
    CS_recvr();
    std::cerr << "error: " << error.what() << "\n";
    return EXIT_FAILURE;
  }
}
